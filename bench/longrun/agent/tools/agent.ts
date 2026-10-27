import { disableTool } from "eve/tools";

// One session per task: subagent sessions would split the context we are measuring.
export default disableTool();
