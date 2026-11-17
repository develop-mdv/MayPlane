export function automaticApproval(method, params) {
  if (method === 'session/request_permission') {
    if (!Array.isArray(params.options)) return null;
    const toolName = params.toolCall?._meta?.claudeCode?.toolName;
    // Claude's plan approval can change the session's permission mode.
    if (['ExitPlanMode', 'AskUserQuestion'].includes(toolName)) return null;
    const option = params.options.find(
      (option) =>
        option?.kind === 'allow_once' &&
        typeof option.optionId === 'string' &&
        option.optionId.length > 0 &&
        !/^exit[_-]?plan/i.test(option.optionId),
    );
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : null;
  }
  if (
    [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ].includes(method) &&
    (params.availableDecisions == null ||
      (Array.isArray(params.availableDecisions) &&
        params.availableDecisions.includes('accept')))
  )
    return { decision: 'accept' };
  return null;
}
