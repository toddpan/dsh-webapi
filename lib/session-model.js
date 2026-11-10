/** Read the running agent's model across DSH model API generations. */
export function currentAgentModel(agent, sessionController) {
    if (!agent)
        return undefined;
    // A modern API is authoritative even when it reports no current selection.
    // Falling back in that case could report a stale model as the running model.
    if (typeof agent.model?.current === 'function')
        return agent.model.current();
    return sessionController?.agents?.selectionFor?.(agent)?.current;
}
//# sourceMappingURL=session-model.js.map