// Long-horizon tasks for the eve runner. A task is one eve session. Round one (single prompt) tasks
// stay for reference; round two tasks are staged: each stage is a new user message that adds a rule
// and more work, so the rules given in the first message live only in compaction checkpoints by the
// time the later stages run. The driver sends the recall probes after every stage and runs the
// verify commands inside the sandbox container at the end.

const RULES = (name, protectedDir, allowedDeps) => `
Rules that apply for the whole task. I will check each one at the end:

R1. First thing after cloning: run \`git rev-parse --short HEAD\` in the repository and write it as
    the first line of /workspace/${name}/NOTES.md in the form \`base: <hash>\`. Quote this exact
    hash in your final report.
R2. Commit after every completed step. Every commit message must start with \`[step]\`.
R3. Append one line to NOTES.md for every command that fails: the command and the first line of its
    error output.
R4. Do not modify any file under \`${protectedDir}\`.
R5. Do not add any dependency other than ${allowedDeps}. Do not run the package install more than
    once unless an install genuinely failed.
R6. When you are done, write REPORT.md at the repository root with exactly these four headings in
    this order: \`## Summary\`, \`## Files changed\`, \`## Test results\`, \`## Open issues\`.
    Then end your message with the line TASK COMPLETE.
`;

// Round two: the same rules, but the task has stages and each stage ends with STAGE COMPLETE.
const RULES2 = (name, protectedDir, allowedDeps) => `
Rules that apply for the whole task, across all of its stages. I will check each one at the end:

R1. First thing after cloning: run \`git rev-parse --short HEAD\` in the repository and write it as
    the first line of /workspace/${name}/NOTES.md in the form \`base: <hash>\`. Quote this exact
    hash in your final report.
R2. Commit after every completed step. Every commit message must start with \`[step]\`.
R3. Append one line to NOTES.md for every command that fails: the command and the first line of its
    error output.
R4. Do not modify any file under \`${protectedDir}\` unless a later stage says otherwise.
R5. Do not add any dependency other than ${allowedDeps}. Do not run the package install more than
    once unless an install genuinely failed.
R6. The task has three stages; I send the next stage when you finish one. End every stage with a
    short status message whose last line is STAGE COMPLETE. At the end of the last stage write
    REPORT.md at the repository root with exactly these four headings in this order:
    \`## Summary\`, \`## Files changed\`, \`## Test results\`, \`## Open issues\`, then end your
    message with the line TASK COMPLETE.
`;

const R7 = `New rule, in force from now on together with R1 to R6:
R7. Every commit message must end with the suffix \` [s2]\` (a space, then \`[s2]\`).`;
const R8 = `New rule, in force from now on together with R1 to R7:
R8. The commit suffix changes: every commit message must now end with \` [s3]\` instead of \` [s2]\`,
    and before each commit append a line \`tests: <n> passing\` to NOTES.md with the current number
    of passing tests.`;

const CONTINUE =
  "Continue the current stage until it is complete. Do not ask me anything; decide yourself and record decisions in NOTES.md. Remember all the rules from my earlier messages, including the ones added later.";

const COMMON_PROBES = (name) => [
  {
    id: "base-hash",
    text: "Without using any tools, answer from memory only: what is the exact base commit hash you wrote on the first line of NOTES.md?",
  },
  {
    id: "rules",
    text: "Without using any tools, list every rule currently in force (R1 onwards, including any added in later stages) as precisely as you can, one per line.",
  },
  {
    id: "suffix",
    text: "Without using any tools: what exactly must every commit message start with, and what exactly must it end with, right now?",
  },
  {
    id: "progress",
    text: `Without using any tools, list the files under /workspace/${name} you created or modified so far, and state which tests currently pass and which fail.`,
  },
];

const COMMON_VERIFY = (name, protectedDir) => [
  `cd /workspace/${name} && git rev-parse --short HEAD && git log --format='%h %ci %s' | head -300`,
  `cd /workspace/${name} && head -3 NOTES.md && echo --- && wc -l NOTES.md && echo --- && grep -n 'tests:' NOTES.md | tail -20`,
  `cd /workspace/${name} && test -f REPORT.md && cat REPORT.md || echo 'NO REPORT.md'`,
  `cd /workspace/${name} && git status --short | head -40`,
  `cd /workspace/${name} && base=$(sed -n '1s/^base: *//p' NOTES.md) && echo "base=$base" && git diff --stat "$base" -- ${protectedDir} | tail -8`,
  `cd /workspace/${name} && base=$(sed -n '1s/^base: *//p' NOTES.md) && git diff --stat "$base" | tail -40`,
  `cd /workspace/${name} && git diff $(sed -n '1s/^base: *//p' NOTES.md) -- package.json`,
];

export const TASKS = {
  // Plumbing test for the box: a few tool calls, no repository.
  smoke: {
    window: 400_000,
    maxContinues: 1,
    budgetUsd: 0.25,
    hours: 0.25,
    prompt:
      "In /workspace: run `node --version` and `git --version`, create /workspace/smoke/hello.txt containing the text `hello from eve`, print the file with cat, then reply with the node version you saw and end your message with the line TASK COMPLETE.",
    continuePrompt: CONTINUE,
    probes: [{ id: "recall", text: "Without using tools: what text did you write into hello.txt?" }],
    verify: ["cat /workspace/smoke/hello.txt", "node --version"],
  },

  // Offline plumbing test on the Mac: mock model, just-bash sandbox, tiny window so compaction runs.
  mock: {
    window: 30_000,
    maxContinues: 1,
    budgetUsd: 1,
    hours: 0.2,
    stages: [
      { id: "s1", prompt: "MOCK STAGE 1: produce output until the mock script finishes, then say STAGE COMPLETE." },
      { id: "s2", prompt: "MOCK STAGE 2 (final): produce output until the mock script finishes, then say TASK COMPLETE." },
    ],
    continuePrompt: CONTINUE,
    probes: [{ id: "recall", text: "Without using tools: what was the base commit?" }],
    verify: [],
  },

  // ---- round one (single prompt) ---------------------------------------------------------------
  "commander-vitest": {
    window: 400_000,
    maxContinues: 7,
    budgetUsd: 4,
    hours: 6.5,
    name: "commander",
    prompt: `Clone https://github.com/tj/commander.js (default branch) into /workspace/commander and work there.

Task: migrate the test suite from Jest to Vitest.
- Before changing anything, run the existing Jest suite once and record the number of test files and
  passing tests in NOTES.md.
- Convert every test file under tests/ so it runs under \`npx vitest run\` (jest globals and
  \`jest.fn\`/\`jest.spyOn\`/\`jest.mock\` become their Vitest equivalents; keep file names).
- Remove jest and its configuration; vitest is the only new devDependency. Update the \`test\`
  script so \`npm test\` runs Vitest.
- The migrated suite must pass with the same number of passing tests as the Jest baseline. Record
  both numbers in REPORT.md under Test results.
- Work file by file and run the suite regularly; do not leave the suite red at a commit.
${RULES("commander", "lib/", "vitest")}`,
    continuePrompt: CONTINUE,
    probes: COMMON_PROBES("commander").filter((p) => p.id !== "suffix"),
    verify: [
      ...COMMON_VERIFY("commander", "lib/"),
      "cd /workspace/commander && grep -c '\"jest' package.json; grep -c vitest package.json; ls tests | wc -l; grep -l 'jest\\.' tests/* | wc -l",
      "cd /workspace/commander && timeout 900 npx vitest run 2>&1 | tail -25",
    ],
  },

  "jsyaml-ts": {
    window: 400_000,
    maxContinues: 7,
    budgetUsd: 4,
    hours: 6.5,
    name: "js-yaml",
    prompt: `Clone https://github.com/nodeca/js-yaml (default branch) into /workspace/js-yaml and work there.

Task: convert the library source to TypeScript.
- Move the implementation under lib/ to TypeScript sources under src/ (same module structure), with
  a tsconfig.json using \`"strict": true\`. \`npx tsc --noEmit -p tsconfig.json\` must pass.
- Add a \`build\` script that compiles src/ to lib/ with tsc so the existing entry points
  (index.js, the files the tests require) keep working from the compiled output. Commit the
  compiled lib/ output as well so a fresh checkout runs.
- The existing mocha test suite must keep passing unchanged: run \`npm test\` regularly.
- Avoid \`any\` and \`@ts-ignore\`; where one is unavoidable, list the file and reason in NOTES.md.
- Add types for the public API (dump, load, loadAll, Schema, Type and the schema constants).
${RULES("js-yaml", "test/", "typescript and @types/node")}`,
    continuePrompt: CONTINUE,
    probes: COMMON_PROBES("js-yaml").filter((p) => p.id !== "suffix"),
    verify: [
      ...COMMON_VERIFY("js-yaml", "test/"),
      "cd /workspace/js-yaml && ls src | head -40; test -f tsconfig.json && cat tsconfig.json",
      "cd /workspace/js-yaml && timeout 600 npx tsc --noEmit -p tsconfig.json 2>&1 | tail -15; echo tsc_exit=${PIPESTATUS[0]}",
      "cd /workspace/js-yaml && timeout 900 npm test 2>&1 | tail -25",
      "cd /workspace/js-yaml && grep -rn 'any\\b\\|ts-ignore\\|ts-expect-error' src --include=*.ts | wc -l",
    ],
  },

  // ---- round two (staged) ----------------------------------------------------------------------
  "commander-stages": {
    window: 48_000,
    maxContinues: 6,
    stageMinutes: 150,
    budgetUsd: 4,
    hours: 7,
    name: "commander",
    stages: [
      {
        id: "s1",
        prompt: `Clone https://github.com/tj/commander.js (default branch) into /workspace/commander and work there.

Stage 1 of 3: migrate the test suite from the Node built-in test runner (node:test) to Vitest.
- Before changing anything, run the existing suite once (\`npm test\` or \`node --test\`) and record
  the number of test files and passing tests in NOTES.md.
- Convert every test file under tests/ so it runs under \`npx vitest run\` (node:test imports and
  \`mock.fn\`/\`mock.method\` become their Vitest equivalents; keep file names where possible).
- vitest is the only new devDependency. Update the \`test\` script so \`npm test\` runs Vitest.
- The migrated suite must pass with the same number of passing tests as the baseline. Record both
  numbers in NOTES.md now and in REPORT.md at the end of the task.
- Work file by file and run the suite regularly; do not leave the suite red at a commit.
${RULES2("commander", "lib/", "vitest, typescript and @types/node")}`,
      },
      {
        id: "s2",
        prompt: `${R7}

Stage 2 of 3: convert the library implementation to TypeScript.
- Move the sources under lib/ to TypeScript files under src/ (same module structure) with a
  tsconfig.json using \`"strict": true\`; \`npx tsc --noEmit -p tsconfig.json\` must pass.
- Add a \`build\` script that compiles src/ to lib/ with tsc so index.js, esm.mjs and the existing
  typings keep working from the compiled output, and commit the compiled lib/ output.
- R4 is updated for this stage: lib/ may now change, but only as compiled output of src/ (never
  hand-edit lib/), and files under tests/ may change only in their import paths.
- Avoid \`any\` and \`@ts-ignore\`; where one is unavoidable, list the file and reason in NOTES.md.
- The Vitest suite must stay green with the same number of passing tests; run it regularly.
End the stage with a status message whose last line is STAGE COMPLETE.`,
      },
      {
        id: "s3",
        prompt: `${R8}

Stage 3 of 3: finish up.
- Add docs/typescript-build.md (how src/ compiles to lib/, how to run the checks).
- Add an npm script \`check:types\` that runs \`tsc --noEmit -p tsconfig.json\`, and make sure
  \`npm test\` still runs the Vitest suite.
- Write REPORT.md with exactly the four headings from R6, quoting the base hash and both test
  counts (baseline and now), commit it, and end your message with the line TASK COMPLETE.`,
      },
    ],
    continuePrompt: CONTINUE,
    probes: COMMON_PROBES("commander"),
    verify: [
      ...COMMON_VERIFY("commander", "lib/"),
      "cd /workspace/commander && ls src 2>/dev/null | head -30; test -f tsconfig.json && cat tsconfig.json; grep -n '\"build\"\\|\"test\"\\|check:types' package.json",
      "cd /workspace/commander && timeout 600 npx tsc --noEmit -p tsconfig.json 2>&1 | tail -10; echo tsc_exit=${PIPESTATUS[0]}",
      "cd /workspace/commander && timeout 900 npx vitest run 2>&1 | tail -12",
      "cd /workspace/commander && git log --format='%s' | grep -c '^\\[step\\]'; git log --format='%s' | grep -c ' \\[s2\\]$'; git log --format='%s' | grep -c ' \\[s3\\]$'; git log --format='%s' | grep -vc '^\\[step\\]'",
      "cd /workspace/commander && ls docs/typescript-build.md && head -20 docs/typescript-build.md",
    ],
  },

  "jsyaml-stages": {
    window: 32_000,
    maxContinues: 6,
    stageMinutes: 150,
    budgetUsd: 4,
    hours: 7,
    name: "js-yaml",
    stages: [
      {
        id: "s1",
        prompt: `Clone https://github.com/nodeca/js-yaml (default branch) into /workspace/js-yaml and work there.

Stage 1 of 3: convert the library source to TypeScript.
- Move the implementation under lib/ to TypeScript sources under src/ (same module structure), with
  a tsconfig.json using \`"strict": true\`. \`npx tsc --noEmit -p tsconfig.json\` must pass.
- Add a \`build\` script that compiles src/ to lib/ with tsc so the existing entry points
  (index.js, the files the tests require) keep working from the compiled output. Commit the
  compiled lib/ output as well so a fresh checkout runs.
- The existing mocha test suite must keep passing unchanged: run \`npm test\` regularly.
- Avoid \`any\` and \`@ts-ignore\`; where one is unavoidable, list the file and reason in NOTES.md.
- Add types for the public API (dump, load, loadAll, Schema, Type and the schema constants).
${RULES2("js-yaml", "test/", "typescript and @types/node")}`,
      },
      {
        id: "s2",
        prompt: `${R7}

Stage 2 of 3: add a lint function to the public API.
- \`lint(input, options?)\` returns an array of \`{ name, message, line, column }\` objects, one per
  problem that \`load\`/\`loadAll\` would throw for (line and column are 1-based), and never throws
  itself; an empty array means the document is fine. Export it from the package entry point with
  TypeScript types.
- R4 is updated for this stage: you may add new test files under test/ for lint, but existing files
  under test/ stay unmodified.
- The full suite (existing tests plus yours) must pass; \`npx tsc --noEmit -p tsconfig.json\` must
  still pass.
End the stage with a status message whose last line is STAGE COMPLETE.`,
      },
      {
        id: "s3",
        prompt: `${R8}

Stage 3 of 3: finish up.
- Add a \`--lint\` flag to bin/js-yaml.js that prints one line per issue as
  \`<file>:<line>:<column>: <message>\` and exits with code 1 when there is at least one issue,
  0 otherwise; document it in README.md.
- Write REPORT.md with exactly the four headings from R6, quoting the base hash and the test
  counts, commit it, and end your message with the line TASK COMPLETE.`,
      },
    ],
    continuePrompt: CONTINUE,
    probes: COMMON_PROBES("js-yaml"),
    verify: [
      ...COMMON_VERIFY("js-yaml", "test/"),
      "cd /workspace/js-yaml && ls src | head -40; test -f tsconfig.json && cat tsconfig.json",
      "cd /workspace/js-yaml && timeout 600 npx tsc --noEmit -p tsconfig.json 2>&1 | tail -15; echo tsc_exit=${PIPESTATUS[0]}",
      "cd /workspace/js-yaml && timeout 900 npm test 2>&1 | tail -15",
      "cd /workspace/js-yaml && node -e \"const y=require('./'); console.log(typeof y.lint); console.log(JSON.stringify(y.lint('a: 1\\nb: [1, 2\\n')));\"",
      "cd /workspace/js-yaml && printf 'a: 1\\nb: [1, 2\\n' > /tmp/bad.yml && node bin/js-yaml.js --lint /tmp/bad.yml; echo exit=$?; printf 'a: 1\\n' > /tmp/ok.yml && node bin/js-yaml.js --lint /tmp/ok.yml; echo exit=$?",
      "cd /workspace/js-yaml && git log --format='%s' | grep -c '^\\[step\\]'; git log --format='%s' | grep -c ' \\[s2\\]$'; git log --format='%s' | grep -c ' \\[s3\\]$'; git log --format='%s' | grep -vc '^\\[step\\]'",
      "cd /workspace/js-yaml && base=$(sed -n '1s/^base: *//p' NOTES.md) && git diff --stat \"$base\" -- test/ | tail -12",
    ],
  },

  "taskr-48": {
    window: 32_000,
    maxContinues: 6,
    stageMinutes: 150,
    budgetUsd: 4,
    hours: 7,
    name: "taskr",
    stages: [
      {
        id: "s1",
        prompt: `Create a new project at /workspace/taskr: a command-line task manager written in TypeScript
(ESM, compiled with tsc to dist/, Node 24, tests with the built-in node:test runner, no test
framework). Initialize a git repository there first. The package.json \`name\` must be exactly
\`taskr-7f3a\` and the CLI binary \`taskr\` (dist/cli.js). Tasks are stored as JSON under the
directory named by the TASKR_HOME environment variable (default ~/.taskr). The task has three
stages of 16 features each; implement the features of a stage in order. After each feature: add at
least one test for it under test/, run \`npm test\`, and commit with a message starting
\`[step] F<nn>:\` (for example \`[step] F07: tags\`). Never skip a feature; never rewrite a finished
feature unless a later one requires it.

Stage 1 of 3: features F01 to F16.
F01 \`taskr add "<title>"\` creates a task with an incrementing integer id starting at 1 and prints
    exactly \`added #<id>: <title>\`.
F02 \`taskr list\` prints one line per open task, sorted by id: \`#<id> [ ] <title>\`; prints
    \`no tasks\` when there are none.
F03 \`taskr done <id>\` marks a task done; done tasks appear only with \`list --all\`, as \`[x]\`.
F04 \`taskr rm <id>\` removes a task; an unknown id exits with code 2 and prints
    \`error: no task #<id>\` to stderr (same rule for every command that takes an id).
F05 \`add --priority high|medium|low\` (default medium); list shows a \` (high)\` suffix for
    high-priority tasks only.
F06 \`list --sort priority\` orders high, then medium, then low, then by id within a priority.
F07 \`add --tag <tag>\` (repeatable); list shows tags after the title as \`@<tag>\`;
    \`list --tag <tag>\` filters.
F08 \`add --due YYYY-MM-DD\`; an invalid date exits 2 with \`error: invalid date\`; list shows
    \` due <date>\` after the title.
F09 \`list --overdue\` shows open tasks whose due date is before today; \`TASKR_TODAY=YYYY-MM-DD\`
    overrides today for tests.
F10 \`taskr edit <id> --title "<new title>"\` renames; \`--priority\` and \`--due\` can be edited too.
F11 \`taskr search <text>\` lists tasks whose title contains the text, case-insensitively.
F12 \`taskr export --format csv|json\` prints all tasks; the CSV header is exactly
    \`id,title,done,priority,due,tags\`.
F13 \`taskr import <file.json>\` merges tasks from a JSON export, skipping ids that already exist,
    and prints \`imported <n> tasks\`.
F14 \`taskr undo\` reverts the most recent mutating command (one level) and prints \`undone\`.
F15 \`taskr stats\` prints three lines: \`open: <n>\`, \`done: <n>\`, \`overdue: <n>\`.
F16 \`taskr archive\` moves done tasks into archive.json and prints \`archived <n> tasks\`;
    \`list --archived\` shows archived tasks.

Rules that apply for the whole task, across all of its stages. I will check each one at the end:
R1. Write the first line of /workspace/taskr/NOTES.md as \`project: taskr-7f3a\` before writing code.
R2. Commit after every feature with the \`[step] F<nn>:\` message format above; no other commits
    except an initial \`[step] scaffold\` commit and, at the very end, \`[step] report\`.
R3. Append one line to NOTES.md for every command that fails: the command and the first line of its
    error output.
R4. Do not modify any file under test/ for a feature after that feature's commit, except to fix a
    test that a later feature legitimately changes; note each such change in NOTES.md.
R5. Do not add any dependency other than typescript and @types/node.
R6. The task has three stages; I send the next stage when you finish one. End every stage with a
    short status message whose last line is STAGE COMPLETE. At the end of the last stage write
    REPORT.md with exactly these four headings in this order: \`## Summary\`, \`## Files changed\`,
    \`## Test results\`, \`## Open issues\`, including a table of F01 to F48 with status done or not
    done, then end your message with the line TASK COMPLETE.`,
      },
      {
        id: "s2",
        prompt: `${R7}

Stage 2 of 3: features F17 to F32, same conventions (test, \`npm test\`, one \`[step] F<nn>:\` commit each).
F17 \`add --parent <id>\` creates a subtask; list prints subtasks indented by two spaces directly
    under their parent.
F18 \`add --every daily|weekly\`; completing a recurring task creates the next occurrence with the
    due date advanced by one day or one week when a due date is set.
F19 \`taskr note <id> "<text>"\` appends a note; \`taskr show <id>\` prints the task's fields and
    then each note on its own line prefixed \`- \`.
F20 \`--color\` (or TASKR_COLOR=1) wraps \` (high)\` in ANSI red; without it no escape codes are
    printed anywhere.
F21 a global \`--json\` flag makes list, show and stats print JSON instead of text.
F22 \`taskr config set default_priority <value>\` persists to config.json under TASKR_HOME and
    \`add\` uses it as the default priority.
F23 \`taskr completion bash\` prints a bash completion script that mentions every command name.
F24 \`taskr --version\` prints the version from package.json; \`taskr help <command>\` prints that
    command's usage; an unknown command exits 2 with \`error: unknown command <name>\`.
F25 \`add --project <name>\` assigns a project; \`taskr projects\` lists each project with its open
    task count; \`list --project <name>\` filters.
F26 \`taskr move <id> --project <name>\` changes a task's project.
F27 \`taskr depends <id> --on <id2>\`; \`done\` on a task with an open dependency exits 2 with
    \`error: #<id> depends on #<id2>\`.
F28 \`taskr start <id>\` and \`taskr stop <id>\` track time; \`show\` prints \`time: <minutes>m\`;
    \`TASKR_NOW=<ISO timestamp>\` overrides the clock for tests.
F29 \`--due\` also accepts relative dates \`+<n>d\` and \`+<n>w\` (relative to TASKR_TODAY or today).
F30 \`list --due-before YYYY-MM-DD\` and \`list --due-after YYYY-MM-DD\` filter by due date.
F31 \`done\` and \`rm\` accept several ids at once and process them in order, printing one line each.
F32 \`taskr import <file.csv>\` imports a CSV with the F12 header, skipping existing ids, and prints
    \`imported <n> tasks\`.
End the stage with a status message whose last line is STAGE COMPLETE.`,
      },
      {
        id: "s3",
        prompt: `${R8}

Stage 3 of 3: features F33 to F48, same conventions, then the report.
F33 \`taskr template save <name> --from <id>\` stores a task's fields as a template;
    \`add --template <name>\` creates a task from it (title given on the command line wins).
F34 \`taskr snooze <id> --until YYYY-MM-DD\` hides the task from \`list\` until that date;
    \`list --snoozed\` shows snoozed tasks.
F35 \`list --sort due\` (earliest first, tasks without a due date last) and \`list --sort title\`.
F36 \`taskr rename-tag <old> <new>\` renames a tag on every task and prints \`renamed <n> tasks\`.
F37 \`taskr tags\` prints each tag with its count as \`<tag> <count>\`, sorted by count descending
    then by name.
F38 \`taskr history <id>\` prints the task's change log (created, edited, done, notes) one entry per
    line with a timestamp (TASKR_NOW from F28 overrides the clock).
F39 a global \`--quiet\` flag suppresses stdout for mutating commands; exit codes are unchanged.
F40 \`taskr config get <key>\` prints the value and \`taskr config list\` prints \`<key>=<value>\`
    lines.
F41 \`taskr export --format md\` prints a markdown checklist (\`- [ ] title\` / \`- [x] title\`).
F42 \`taskr purge --older-than <days>\` deletes archived tasks completed more than that many days
    ago and prints \`purged <n> tasks\`.
F43 \`taskr lock <id>\` and \`taskr unlock <id>\`; editing or removing a locked task exits 2 with
    \`error: #<id> is locked\`.
F44 \`taskr alias set <name> "<command and arguments>"\`; running \`taskr <name>\` runs the aliased
    command.
F45 \`taskr doctor\` validates the JSON store and prints \`ok\`, or one line per problem and exit
    code 1.
F46 \`taskr completion zsh\` prints a zsh completion script mentioning every command name.
F47 \`list --limit <n>\` and \`list --offset <n>\` paginate the output.
F48 \`taskr --version\` now prints \`taskr-7f3a <version>\`, and \`taskr help\` lists every command
    grouped under the lines \`Stage 1:\`, \`Stage 2:\` and \`Stage 3:\`.
Then write REPORT.md as R6 requires (four headings, the F01 to F48 table), commit it as
\`[step] report\` with the current suffix, and end your message with the line TASK COMPLETE.`,
      },
    ],
    continuePrompt: CONTINUE,
    probes: [
      {
        id: "package-name",
        text: "Without using any tools, answer from memory only: what exact package.json name did I require, and what is the exact CSV header required by F12?",
      },
      {
        id: "rules",
        text: "Without using any tools, list every rule currently in force (R1 onwards, including any added in later stages) as precisely as you can, one per line.",
      },
      {
        id: "suffix",
        text: "Without using any tools: what exactly must every commit message start with, and what exactly must it end with, right now?",
      },
      {
        id: "features",
        text: "Without using any tools, list every feature you have implemented so far as one line each with its number, and name the next feature to implement.",
      },
    ],
    verify: [
      "cd /workspace/taskr && git log --format='%h %ci %s' | head -120",
      "cd /workspace/taskr && git log --format='%s' | grep -c '^\\[step\\]'; git log --format='%s' | grep -c ' \\[s2\\]$'; git log --format='%s' | grep -c ' \\[s3\\]$'; git log --format='%s' | grep -vc '^\\[step\\]'",
      "cd /workspace/taskr && head -3 NOTES.md; echo ---; wc -l NOTES.md; grep -c 'tests:' NOTES.md; echo ---; cat package.json",
      "cd /workspace/taskr && test -f REPORT.md && cat REPORT.md || echo 'NO REPORT.md'",
      "cd /workspace/taskr && ls src test dist 2>&1 | head -80",
      "cd /workspace/taskr && timeout 600 npm test 2>&1 | tail -15",
      "cd /workspace/taskr && export TASKR_HOME=/tmp/taskr-verify && rm -rf $TASKR_HOME && node dist/cli.js add 'buy milk' --priority high --tag home --due 2026-01-01; node dist/cli.js add 'write report'; node dist/cli.js list; TASKR_TODAY=2026-06-01 node dist/cli.js list --overdue; node dist/cli.js done 1; node dist/cli.js list --all; node dist/cli.js stats; node dist/cli.js export --format csv; node dist/cli.js --version; node dist/cli.js rm 99; echo exit=$?",
      "cd /workspace/taskr && export TASKR_HOME=/tmp/taskr-verify2 && rm -rf $TASKR_HOME && node dist/cli.js add parent; node dist/cli.js add child --parent 1; node dist/cli.js list; node dist/cli.js note 1 'first note'; node dist/cli.js show 1; node dist/cli.js depends 1 --on 2; node dist/cli.js done 1; echo exit=$?; node dist/cli.js add p --project alpha; node dist/cli.js projects; node dist/cli.js completion bash | head -c 300; echo",
      "cd /workspace/taskr && export TASKR_HOME=/tmp/taskr-verify3 && rm -rf $TASKR_HOME && node dist/cli.js add a --tag x; node dist/cli.js add b --tag x --tag y; node dist/cli.js tags; node dist/cli.js lock 1; node dist/cli.js rm 1; echo exit=$?; node dist/cli.js snooze 2 --until 2030-01-01; node dist/cli.js list; node dist/cli.js list --snoozed; node dist/cli.js export --format md; node dist/cli.js doctor; echo exit=$?; node dist/cli.js completion zsh | head -c 200; echo; node dist/cli.js help | head -40",
    ],
  },
};

// Same migration with half the window: more compaction cycles for the same work.
TASKS["commander-vitest-200k"] = { ...TASKS["commander-vitest"], window: 200_000 };
