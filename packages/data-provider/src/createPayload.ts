import type * as t from './types';
import { EndpointURLs } from './config';
import * as s from './schemas';

/** Resolves the browser's IANA timezone so the server can localize prompt variables. */
function getUserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export default function createPayload(submission: t.TSubmission) {
  const {
    isEdited,
    addedConvo,
    userMessage,
    isContinued,
    isTemporary,
    isRegenerate,
    conversation,
    editedContent,
    ephemeralAgent,
    endpointOption,
    manualSkills,
    forceCompaction,
    clientRequestId,
    recoverySteerId,
    expectedPredecessorCreatedAt,
  } = submission;
  const { conversationId } = s.tConvoUpdateSchema.parse(conversation);
  /** ADR fork: carry the "Always" note verbatim off the conversation. Read
   *  directly rather than through `tConvoUpdateSchema` so an empty string
   *  survives as a deliberate clear instead of being normalized away. */
  const persistentContext =
    typeof conversation?.persistentContext === 'string'
      ? conversation.persistentContext
      : undefined;
  const { endpoint: _e, endpointType } = endpointOption as {
    endpoint: s.EModelEndpoint;
    endpointType?: s.EModelEndpoint;
  };

  const endpoint = _e as s.EModelEndpoint;
  let server = `${EndpointURLs[s.EModelEndpoint.agents]}/${endpoint}`;
  if (s.isAssistantsEndpoint(endpoint)) {
    server =
      EndpointURLs[(endpointType ?? endpoint) as 'assistants' | 'azureAssistants'] +
      (isEdited ? '/modify' : '');
  }

  const payload: t.TPayload = {
    ...userMessage,
    ...endpointOption,
    endpoint,
    addedConvo,
    isTemporary,
    isRegenerate,
    editedContent,
    conversationId,
    isContinued: !!(isEdited && isContinued),
    ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
    manualSkills: s.isAssistantsEndpoint(endpoint) ? undefined : manualSkills,
    timezone: getUserTimezone(),
    persistentContext,
    forceCompaction,
    clientRequestId,
    recoverySteerId,
    expectedPredecessorCreatedAt,
  };

  return { server, payload };
}
