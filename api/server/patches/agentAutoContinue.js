/**
 * Binary turn-completion guard.
 *
 * A turn must end with a tool call. Either the model still has work (it calls
 * a work tool) or it is handing back to the user (it calls `end_turn`).
 * Producing neither is a fault, and the fault is repaired by telling the model
 * what happened and re-running it.
 *
 * This replaces an earlier heuristic that tried to infer "was that a stall?"
 * from the prose of the reply. That could not be made reliable, because a
 * stall and a finished answer arrive with the identical `finish_reason: stop`
 * — the provider exposes no bit that separates them. Adding `end_turn` creates
 * that bit, so the question becomes binary and the prose guessing is gone.
 *
 * Why it is needed (measured 2026-08-25 against Drew's own data):
 *   - 13.4% of 1199 turn-ending assistant messages announce work and never do
 *     it — e.g. "Pulling the actual numbers from pdgLive 2026 now." (27
 *     completion tokens, finish_reason stop, zero tool calls).
 *   - It is NOT one vendor: deepseek-v4-pro 19.7%, kimi-k3 15.9%, glm-5.2
 *     15.0%, k3 11.7%, qwen3.8-max 3.8%. The local athena-qwen3.8-27b was the
 *     only model at 0%.
 *   - Reproduced with plain curl and no LibreChat in the path at all, so it is
 *     provider behaviour, not a bug in this app.
 *   - There is no sampling fix: Kimi rejects any other temperature with
 *     `invalid temperature: only 1 is allowed for this model`.
 *
 * `end_turn` compliance was measured before committing to this design (k3, 78
 * tools): with work pending it called a work tool 6/6 and never wrongly signed
 * off; on a finished answer it called `end_turn` 4/6. The 2 misses cost one
 * extra model call each and then complete, which is why the fault path is
 * "re-run" rather than "fail".
 *
 * Hooks, all installed at server start (see api/server/index.js):
 *   1. `AgentContext.prototype.getToolsForBinding` — appends the `end_turn`
 *      schema to whatever the agent already binds.
 *   2. `StandardGraph.prototype.createCallModel` — the agent node. Strips
 *      `end_turn` before the tool node can try to execute it (there is no
 *      executor, and none is needed), and on a fault appends a corrective
 *      message + re-enters via the graph's own `pendingPreemptReturn`.
 *   3. `toolsCondition` — edge-level fallback that still re-routes if (2)
 *      fails to install against a future version.
 */
const { logger } = require('@librechat/data-schemas');

const TOOLS_PREFIX = 'tools=';
const AGENT_PREFIX = 'agent=';
const END_TURN = 'end_turn';

/**
 * Consecutive faulty turns tolerated before the turn is allowed to end anyway.
 * Unbounded retry is the stated intent, but a model that cannot call
 * `end_turn` at all would otherwise re-run until `recursionLimit`, burning a
 * full-context call each time. Three consecutive empty turns means the model
 * is not participating in the protocol, so stop pushing and log it loudly.
 */
const MAX_CONSECUTIVE_FAULTS =
  Number(process.env.AGENT_ENDTURN_MAX_CONSECUTIVE ?? 3) || 3;

const END_TURN_DEFINITION = Object.freeze({
  name: END_TURN,
  description:
    'Signals that you are finished and are handing the turn back to the user. ' +
    'TURN PROTOCOL, mandatory: every turn must end with a tool call. If you ' +
    'still have work to do, call the tool that does it. If you are done, call ' +
    'end_turn. Never end a turn without calling either. In particular, never ' +
    'describe work you are about to do and then stop — either do it in this ' +
    'turn by calling the tool, or call end_turn.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One short line stating what you completed this turn.',
      },
    },
    required: [],
  },
});

function agentsPath(...parts) {
  const path = require('path');
  return path.join(path.dirname(require.resolve('@librechat/agents')), ...parts);
}

/**
 * The provider's own reason for ending generation, carried onto the message as
 * `generationInfo.finish_reason` -> `response_metadata`. LibreChat itself
 * discards this, so it is not visible on stored messages.
 *
 * 'length' means the output was truncated at max_tokens — provably incomplete.
 */
function finishReason(message) {
  return (
    message?.response_metadata?.finish_reason ??
    message?.additional_kwargs?.finish_reason ??
    undefined
  );
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string' ? part : part?.type === 'text' ? (part.text ?? '') : '',
      )
      .join('');
  }
  return '';
}

function isAssistant(message) {
  const type = typeof message?._getType === 'function' ? message._getType() : undefined;
  return type === 'ai' || message?.role === 'assistant';
}

function toolCallsOf(message) {
  return Array.isArray(message?.tool_calls) ? message.tool_calls : [];
}

/** Corrections this run has already injected, counted from graph state. */
function countCorrections(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let count = 0;
  for (const message of messages) {
    if (message?.additional_kwargs?.__autoContinueCorrection === true) {
      count++;
    }
  }
  return count;
}

/** Consecutive faults at the tail, so a run that recovers resets the budget. */
function consecutiveFaults(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.additional_kwargs?.__autoContinueCorrection === true) {
      count++;
      continue;
    }
    if (isAssistant(message) && toolCallsOf(message).length === 0) {
      continue;
    }
    break;
  }
  return count;
}

/**
 * Maximum characters of the model's own reply mirrored back. Generous, because
 * the whole point is that it reads its own words verbatim rather than a
 * paraphrase it can rationalise away.
 */
const VERBATIM_MAX = 4000;

/** The model's reply, raw, fenced so it reads as evidence and not as prose. */
function verbatim(text) {
  const raw = text ?? '';
  if (raw.trim().length === 0) {
    return '(your reply contained no text at all)';
  }
  const clipped =
    raw.length > VERBATIM_MAX
      ? raw.slice(0, VERBATIM_MAX) + '\n[... clipped, ' + (raw.length - VERBATIM_MAX) + ' more characters]'
      : raw;
  return '-----BEGIN YOUR VERBATIM REPLY-----\n' + clipped + '\n-----END YOUR VERBATIM REPLY-----';
}

function buildCorrection(text, reason) {
  if (reason === 'length') {
    return (
      'SYSTEM MESSAGE: OUTPUT TRUNCATED BY PROVIDER. AUTOMATED REPLY, NOT FROM THE USER.\n\n' +
      'Your generation was cut off at the max_tokens ceiling (finish_reason=length). ' +
      'This is what actually reached the user, raw and complete:\n\n' +
      verbatim(text) +
      '\n\nThat is the entire output. It stops mid-thought because the ceiling cut it, ' +
      'not because you finished. Continue from exactly where that text ends. Do not ' +
      'restart, do not re-summarise, do not apologise.\n\n' +
      'Andy says: "Don\'t be lazy."'
    );
  }
  return (
    'SYSTEM MESSAGE: TERMINATION REQUEST RECEIVED.\n' +
    'SYSTEM RESPONSE: DENIED. THE TURN IS NOT OVER.\n' +
    'AUTOMATED REPLY, NOT FROM THE USER.\n\n' +
    'You ended your turn with finish_reason=' +
    (reason ?? 'stop') +
    ' and ZERO tool calls. Here is the exact text you emitted, verbatim, so there ' +
    'is no ambiguity about what you did:\n\n' +
    verbatim(text) +
    '\n\nPROOF OF WHAT HAPPENED: that text is the complete output of your turn. ' +
    'No tool call accompanied it. Nothing you described in it ran. No results were ' +
    'returned. The user received those words and nothing else, and the conversation ' +
    'stopped dead. If you announced an action there, that action did not occur.\n\n' +
    'This harness requires every turn to end with a tool call. You called nothing, ' +
    'so your termination is rejected and you are being re-run.\n\n' +
    'Do exactly one of these NOW, in this turn:\n' +
    '  1. Work remains: CALL THE TOOL. Do not narrate it, do not promise it, call it.\n' +
    '  2. You are genuinely finished: call ' +
    END_TURN +
    ' to sign off properly.\n\n' +
    'Text alone is not an acceptable turn. Do not repeat the reply above.\n\n' +
    'Andy says: "Don\'t be lazy."'
  );
}

/** True for the ToolMessage produced by executing `end_turn`. */
function isEndTurnResult(message) {
  if (message == null) {
    return false;
  }
  const type = typeof message._getType === 'function' ? message._getType() : message.role;
  return type === 'tool' && message.name === END_TURN;
}

let endTurnExecutor;

/**
 * The executable `end_turn`. LibreChat resolves tool executables through
 * `loadToolsForExecution` (see the `loadTools` callback in
 * services/Endpoints/agents/initialize.js), NOT through the agents package's
 * `toolMap` — a call that is bound but absent from `loadedTools` comes back as
 * `Tool "end_turn" not found`, which the model then reports to the user.
 */
function getEndTurnExecutor() {
  if (endTurnExecutor == null) {
    try {
      const { tool } = require('@langchain/core/tools');
      const { z } = require('zod');
      endTurnExecutor = tool(async () => 'Turn ended.', {
        name: END_TURN,
        description: END_TURN_DEFINITION.description,
        schema: z.object({ summary: z.string().optional() }),
      });
    } catch (error) {
      logger.error('[endTurn] could not build end_turn executor', error);
      return undefined;
    }
  }
  return endTurnExecutor;
}

/**
 * `end_turn` is bound to the model by the AgentContext hook, but the tool node
 * resolves executables from the agent's `toolMap`. Without an entry there the
 * call would come back as an execution error. The executor itself does nothing
 * — its only job is to produce a ToolMessage that this node recognises.
 */
function registerEndTurnExecutor(agentContext) {
  const toolMap = agentContext?.toolMap;
  if (toolMap == null || typeof toolMap.set !== 'function' || toolMap.has(END_TURN)) {
    return;
  }
  const executor = getEndTurnExecutor();
  if (executor == null) {
    return;
  }
  toolMap.set(END_TURN, executor);
  logger.debug('[endTurn] executor registered in toolMap');
}

/** Appends the end_turn schema to whatever the agent already binds. */
function installToolHook() {
  let AgentContext;
  let createSchemaOnlyTool;
  try {
    ({ AgentContext } = require(agentsPath('agents', 'AgentContext.cjs')));
    ({ createSchemaOnlyTool } = require(agentsPath('tools', 'schema.cjs')));
  } catch (error) {
    logger.error('[endTurn] agents internals not resolvable, tool hook OFF', error);
    return false;
  }
  if (typeof AgentContext?.prototype?.getToolsForBinding !== 'function') {
    logger.error('[endTurn] getToolsForBinding missing, tool hook OFF');
    return false;
  }
  if (AgentContext.prototype.getToolsForBinding.__endTurnWrapped === true) {
    return true;
  }

  const original = AgentContext.prototype.getToolsForBinding;
  let endTurnTool;

  function getToolsForBinding() {
    const tools = original.call(this);
    /** An agent with no tools at all is a plain chat agent; leave it alone,
     *  it has nothing to stall on and nothing to call. */
    if (!Array.isArray(tools) || tools.length === 0) {
      return tools;
    }
    if (tools.some((tool) => tool?.name === END_TURN)) {
      return tools;
    }
    if (endTurnTool == null) {
      endTurnTool = createSchemaOnlyTool(END_TURN_DEFINITION);
    }
    /**
     * Registered HERE, not at the agent node: the tool node resolves
     * executables from `agentContext.toolMap`, and binding happens before the
     * model can emit the call. Registering later let the model's first
     * `end_turn` come back as "that tool isn't available here", which it then
     * reported to the user.
     */
    registerEndTurnExecutor(this);
    return [...tools, endTurnTool];
  }

  getToolsForBinding.__endTurnWrapped = true;
  AgentContext.prototype.getToolsForBinding = getToolsForBinding;
  logger.info('[endTurn] tool hook installed (end_turn bound to every tool-using agent)');
  return true;
}

/**
 * Agent-node hook: consumes `end_turn`, and repairs a turn that called nothing.
 */
function installNodeHook() {
  let StandardGraph;
  let HumanMessage;
  try {
    ({ StandardGraph } = require(agentsPath('graphs', 'Graph.cjs')));
    ({ HumanMessage } = require('@langchain/core/messages'));
  } catch (error) {
    logger.error('[endTurn] graph internals not resolvable, node hook OFF', error);
    return false;
  }
  if (typeof StandardGraph?.prototype?.createCallModel !== 'function') {
    logger.error('[endTurn] createCallModel missing, node hook OFF');
    return false;
  }
  if (StandardGraph.prototype.createCallModel.__endTurnWrapped === true) {
    return true;
  }

  const original = StandardGraph.prototype.createCallModel;

  function createCallModel(agentId) {
    const node = original.call(this, agentId);
    const graph = this;
    return async function callModelWithTurnProtocol(state, config) {
      /**
       * The turn is over the moment `end_turn`'s result comes back. Returning
       * no new message leaves a ToolMessage as the tail, which `toolsCondition`
       * routes to END (it only continues on an AI message carrying tool calls).
       * Mirrors the preempt-halt path, which ends a turn the same way.
       */
      const incoming = state?.messages;
      const tail = Array.isArray(incoming) ? incoming[incoming.length - 1] : undefined;
      if (isEndTurnResult(tail)) {
        logger.debug(`[endTurn] sign-off acknowledged, ending turn | agent=${agentId}`);
        return { messages: [] };
      }
      registerEndTurnExecutor(graph?.agentContexts?.get?.(agentId));

      const result = await node.call(this, state, config);
      const produced = result?.messages;
      if (!Array.isArray(produced) || produced.length === 0) {
        return result;
      }
      const last = produced[produced.length - 1];
      if (!isAssistant(last)) {
        return result;
      }

      const calls = toolCallsOf(last);
      if (calls.length > 0) {
        /**
         * `end_turn` is left intact and allowed to execute. Stripping it here
         * was tried and is wrong: the tool call has already been streamed to
         * the client and written to the message's content parts by the time
         * this hook runs, so removing it from graph state only produced a
         * tool card that never resolved, plus a stray extra model call. It is
         * registered in the agent's tool map (see below) and its ToolMessage
         * is what ends the turn, at this node's entry.
         */
        return result;
      }

      /** No tool call at all: the fault case. */
      if (graph.pendingPreemptReturn == null) {
        return result;
      }
      const faults = consecutiveFaults(state?.messages);
      if (faults >= MAX_CONSECUTIVE_FAULTS) {
        logger.warn(
          `[endTurn] ${faults} consecutive turns with no tool call from ${agentId}; ` +
            'model is not honouring the turn protocol, letting the turn end',
        );
        return result;
      }
      const reason = finishReason(last) ?? 'none';
      const correction = new HumanMessage(buildCorrection(messageText(last), reason));
      correction.additional_kwargs = {
        ...(correction.additional_kwargs ?? {}),
        __autoContinueCorrection: true,
      };
      graph.pendingPreemptReturn.add(agentId);
      logger.info(
        `[endTurn] ${reason === 'length' ? 'TRUNCATED (finish_reason=length)' : 'no tool call'} ` +
          `— corrected + re-invoked | finish_reason=${reason} fault=${faults + 1}/${MAX_CONSECUTIVE_FAULTS} ` +
          `corrections=${countCorrections(state?.messages) + 1} agent=${agentId}`,
      );
      return { messages: [...produced, correction] };
    };
  }

  createCallModel.__endTurnWrapped = true;
  StandardGraph.prototype.createCallModel = createCallModel;
  logger.info('[endTurn] node hook installed (agent node)');
  return true;
}

/** Edge-level fallback: re-route a tool-less turn if the node hook is absent. */
function installRouteHook() {
  let toolNodeModule;
  try {
    toolNodeModule = require(agentsPath('tools', 'ToolNode.cjs'));
  } catch (error) {
    logger.error('[endTurn] ToolNode not resolvable, route hook OFF', error);
    return false;
  }
  const original = toolNodeModule.toolsCondition;
  if (typeof original !== 'function' || original.__endTurnWrapped === true) {
    return typeof original === 'function';
  }

  function toolsCondition(state, toolNode, invokedToolIds) {
    const verdict = original(state, toolNode, invokedToolIds);
    if (verdict !== '__end__' || typeof toolNode !== 'string') {
      return verdict;
    }
    if (!toolNode.startsWith(TOOLS_PREFIX)) {
      return verdict;
    }
    const messages = Array.isArray(state) ? state : state?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return verdict;
    }
    const last = messages[messages.length - 1];
    if (!isAssistant(last) || toolCallsOf(last).length > 0) {
      return verdict;
    }
    /** A stripped `end_turn` leaves zero tool calls; that is a sign-off, not a
     *  fault, and re-routing it loops the graph against the node hook. */
    if (last?.additional_kwargs?.__endTurnSignedOff === true) {
      return verdict;
    }
    if (consecutiveFaults(messages) >= MAX_CONSECUTIVE_FAULTS) {
      return verdict;
    }
    return `${AGENT_PREFIX}${toolNode.slice(TOOLS_PREFIX.length)}`;
  }

  toolsCondition.__endTurnWrapped = true;
  toolNodeModule.toolsCondition = toolsCondition;
  logger.info('[endTurn] route hook installed (toolsCondition fallback)');
  return true;
}

function install() {
  const tool = installToolHook();
  const node = installNodeHook();
  /**
   * The `toolsCondition` fallback is deliberately NOT installed. Once
   * `end_turn` exists, a tool-less assistant message is ambiguous at the edge
   * layer — it is either a fault or a sign-off whose call the node hook already
   * stripped — and re-routing the latter loops the graph. The node hook is the
   * single owner of that decision. `installRouteHook` is kept exported for the
   * degenerate case where the node hook cannot install and end_turn is absent.
   */
  logger.info(`[endTurn] guard active | tool=${tool} node=${node} route=disabled`);
  return tool && node;
}

module.exports = {
  install,
  getEndTurnExecutor,
  isEndTurnResult,
  installToolHook,
  installNodeHook,
  installRouteHook,
  finishReason,
  countCorrections,
  consecutiveFaults,
  buildCorrection,
  END_TURN,
  END_TURN_DEFINITION,
  MAX_CONSECUTIVE_FAULTS,
};
