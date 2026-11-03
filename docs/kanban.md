# Project boards

Each project has a board shared by the local CodexNest and ClaudeNest instances.
Open **Task board** from the project's menu, a session's actions or the board icon
in the session header. From a task's session the board opens with that task.
Both applications must run as the same operating-system user and resolve the
project to the same directory.

Column widths can be dragged and columns collapsed; Done starts collapsed. These
choices are remembered on each device. On a phone the board shows one stage at a
time. Task details open in a side panel.

Create a card with **+**, type or dictate its description, and send it. An agent
assigns a category without asking questions. Questions about the work itself
appear in the execution session. There is no permanent board chat.

The initial stages are **To do → In progress → Review → Ready to merge → Done**.
Additional stages have a name and an optional description. Moving a card changes
its stage; session controls remain in the session. A move to Done cannot bypass
the publication checks.

## Execution and review

Starting a card creates a normal session in the current application, using its
new-session defaults. The session belongs to the original project but works in
an isolated workspace. A card cannot run twice at the same time, including across
the two applications.

The session's opening message shows the task title, description and any operator
comment. Internal board commands and workflow rules are kept in a local
instructions file referenced by that message; the agent must read it before
starting. The same applies to review, integration and rework messages in both
applications.

One card can involve several repositories. Each gets its own worktree, task
branch, starting commit and target branch. The target comes from the assignment;
the executor asks in its session when it cannot determine the intended branch.
Existing uncommitted changes are never silently included. The executor must
explicitly choose a committed baseline or arrange a preliminary commit.

Projects containing several repositories retain their directory structure.
Nested repositories keep their own histories. A local-only Git repository may
track files belonging to a previously unversioned project directory; child
repositories and generated/runtime data are excluded from that repository.

If there are no other started, unfinished cards in the project, the executor can
finish the complete workflow: check, integrate and publish. Unstarted backlog
cards do not prevent this. The condition is checked again before integration.

Parallel results go through review. Accept a result yourself or start a separate
review session. **Rework** sends a typed or dictated comment back to the original
executor, including when requested from the other application. That application
must be running to deliver the continuation; the request remains queued otherwise.

## Integration and publication

Select accepted cards to integrate. The integration agent assembles their exact
accepted commits in separate worktrees, resolves conflicts and incompatibilities,
and checks the combined result. It asks for operator input when a decision is
needed. Normal merge conflicts do not require manual intervention by themselves.

Publication never force-pushes or discards changes in an original working copy.
The target branch is checked again before promotion. Repository-specific
instructions still apply, including restrictions on publishing and deployment.
Deployment is a separate assignment.

For a remote repository, Done requires a successful push. For a local-only
repository, successful integration into the local target branch is sufficient.
Read-only tasks do not require a Git publication. A card involving several
repositories finishes when all required results have been published. Independent
repositories cannot be pushed as one atomic transaction; partial success is
recorded so a retry can continue from the remaining repository.

## Shared storage and links

Boards, queued work and agent receipts live in
`~/.local/share/nest-apps/kanban`, outside project repositories. Set
`KANBAN_DATA_DIR` to use another shared directory; both applications must use the
same value. State is written atomically under interprocess locks. Restarting an
application preserves cards, workspace metadata and queued continuations.

Session links use the current hostname with the default application ports
(`4310` for CodexNest and `4311` for ClaudeNest). Reverse proxies and custom ports
can override the sibling application addresses with `KANBAN_CODEX_URL` and
`KANBAN_CLAUDE_URL` on both servers.

Worktrees isolate ordinary working files. They are not an operating-system
sandbox: the agent retains the permissions of its configured runtime. Board
commands are scoped to the assigned card unless the assignment explicitly
delegates management of other cards.
