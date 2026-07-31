const { ViolationTypes } = require('librechat-data-provider');

/**
 * Whether an error is the balance middleware's structured refusal
 * (`checkBalance` throws `JSON.stringify({ type: 'token_balance', ... })`). A
 * scheduled run failing on the OWNER's credits is not the schedule's fault: it
 * must settle as `skipped_balance` (walking the insufficient_balance streak)
 * rather than `error` (walking too_many_failures).
 */
function isBalanceViolationError(error) {
  const message = error?.message;
  if (typeof message !== 'string' || !message.startsWith('{')) {
    return false;
  }
  try {
    return JSON.parse(message)?.type === ViolationTypes.TOKEN_BALANCE;
  } catch {
    return false;
  }
}

module.exports = { isBalanceViolationError };
