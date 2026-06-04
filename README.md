# pi-subagents

Subagent extension for [pi](https://pi.dev). It lets you define named agents as Markdown files and run them manually from pi slash commands.

Subagents run in a separate pi process with their own child session, so they do not see the parent conversation history. They still load normal pi project context (`AGENTS.md` / `CLAUDE.md`), skills, extensions, and tools.

> Experimental package. The current implementation is command-based, not a live OpenCode-style child-session UI.

## Install

From GitHub:

```bash
pi install git:github.com/kaufdev/pi-subagents@v0.1.2
```

For pidocker:

```bash
pidocker packages add git:github.com/kaufdev/pi-subagents@v0.1.2
```

## Agent files

Create agents in one of these locations:

- Global: `~/.pi/agent/agents/*.md`
- Project: `.pi/agents/*.md`

Project agents override global agents with the same `name`.

Example:

```md
---
name: reviewer
description: Review code and report risks
---

You are a reviewer. Check code quality, bugs, and application-level fit.
Return concrete findings with file paths and line numbers where possible.
```

After adding/changing agents, run `/reload` in pi.

## Usage

Run by agent name:

```text
/reviewer review the latest commit
```

Or use the generic command:

```text
/agent reviewer review ~/.pi/agent/extensions/subagents/index.ts
```

The parent session receives the subagent result. The result includes the child session path for later inspection via pi's normal session tools.


## Tools

This package also registers tools for the main agent:

- `subagent` - run any named subagent with `{ agent, task }`
- `tester` - convenience tool that runs the `tester` subagent

The tools are intended for the parent/main agent. Nested subagent calls from inside a subagent are blocked.

## What is isolated?

The subagent runs with:

- a separate pi process
- `--no-session`-style isolation from the parent conversation history, implemented as a dedicated child session file
- the same model and thinking level as the parent session
- normal project/global pi context, skills, extensions, and tools

## Examples

Example agent files are in:

```text
examples/agents/
```

They are examples only; they are not loaded automatically.
