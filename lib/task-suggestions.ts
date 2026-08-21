import type { PersistedFrameworkEvent } from "@zmzai/agent-framework";

export type TaskSuggestion = { label: string; prompt: string };

type SuggestionInput = {
  task: { goal: string; status: string } | null;
  latestRun: { status: string; terminalReason?: string | null } | null;
  approvals: Array<{ status: string }>;
  subagents: Array<{ status: string; description: string }>;
  events: PersistedFrameworkEvent[];
};

/** 从事件流取最近一次 qa-check 的失败项文案（用于精准修复指令）。 */
function latestFailedChecks(events: PersistedFrameworkEvent[]): string[] {
  const sorted = [...events].sort((left, right) => right.seq - left.seq);
  for (const event of sorted) {
    if (event.type !== "message.part.updated" || event.data.part.type !== "tool" || event.data.part.tool !== "qa-check") continue;
    if (event.data.part.state.status !== "completed") continue;
    const result = event.data.part.state.metadata?.qaCheck as { checks?: Array<{ status: string; message: string }> } | undefined;
    if (result && Array.isArray(result.checks)) {
      const failed = result.checks.filter((check) => check.status === "failed").map((check) => check.message);
      if (failed.length) return failed;
    }
  }
  return [];
}

/** 按任务实时状态生成 2-4 条"下一步怎么修/怎么继续"的快捷指令。
 *  文案由失败原因、质量检查失败项、审批/子任务状态动态拼出，不是写死的固定列表。 */
export function buildTaskSuggestions(input: SuggestionInput): TaskSuggestion[] {
  const { task, latestRun, approvals, subagents, events } = input;
  const runStatus = latestRun?.status ?? task?.status ?? "created";
  const pendingApproval = approvals.some((approval) => approval.status === "pending");
  const failedSubagents = subagents.filter((subagent) => subagent.status === "failed");

  // 有待审批时审批卡本身就是动作位，不再给指令。
  if (pendingApproval) return [];

  const suggestions: TaskSuggestion[] = [];

  if (runStatus === "waiting_input") {
    suggestions.push(
      { label: "让 Agent 说明缺什么", prompt: "请具体列出你还需要我提供哪些信息或确认哪些事项，我逐条补充。" },
      { label: "跳过阻塞继续", prompt: "跳过当前等待的输入，用现有信息继续完成任务，缺什么就先用合理默认值。" },
    );
  }

  if (runStatus === "failed") {
    const reason = latestRun?.terminalReason ?? "";
    const failedChecks = latestFailedChecks(events);
    if (failedChecks.length) {
      suggestions.push(
        { label: `只修复：${failedChecks[0]!.slice(0, 18)}`, prompt: `只修复质量检查的失败项（${failedChecks.join("、")}），其他已完成的内容不要改动，改完重新运行质量检查。` },
        { label: "先诊断再修", prompt: `质量检查失败了（${failedChecks.join("、")}）。先逐条解释每项失败的具体原因，再给出修复方案并执行。` },
      );
    } else if (reason.includes("APPROVAL")) {
      suggestions.push(
        { label: "换不需授权的做法", prompt: "调整实现方式，避开需要授权的高风险操作（如安装软件、访问外部服务），改用沙箱内可完成的方式重新实现目标。" },
        { label: "缩小范围先交付", prompt: "先只完成不需要授权的部分并交付成果，把需要授权的步骤列出来等我在新任务里确认。" },
      );
    } else if (failedSubagents.length) {
      suggestions.push(
        { label: "只重做失败环节", prompt: `只有部分子任务失败了（${failedSubagents.map((subagent) => subagent.description).slice(0, 2).join("、")}）。不要重做已完成的步骤，只修复失败的部分并汇总结果。` },
      );
    } else {
      suggestions.push(
        { label: "先诊断失败原因", prompt: "上次执行失败了。先分析失败的具体原因并解释给我，然后给出修复方案再执行。" },
        { label: "换一种方式重做", prompt: "换一种实现思路重新完成这个目标，避免复现上次的失败路径。" },
      );
    }
  }

  if (runStatus === "paused") {
    suggestions.push(
      { label: "调整后继续", prompt: "继续执行，但对计划做如下调整：" },
    );
  }

  if (runStatus === "succeeded" || task?.status === "succeeded") {
    suggestions.push(
      { label: "基于成果改进", prompt: "基于这次的成果做一版改进：先指出当前成果的 3 个可改进点，再逐项优化。" },
      { label: "换个场景复用", prompt: "把这次的成果和方法总结成可复用的步骤，说明换一批数据时要改哪些地方。" },
    );
  }

  return suggestions.slice(0, 4);
}
