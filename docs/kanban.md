# Project boards

Each project has a board shared by the local CodexNest and ClaudeNest instances.
Open **Task board** from the project's menu, a session's actions or the board icon
in the session header. From a task's session the board opens with that task.
Both applications must run as the same operating-system user and resolve the
project to the same directory.

The switch at the top of the navigation chooses **Sessions** or **Board**. Board mode
opens the board of the project being viewed (or the one shown last) and lists the
projects instead of sessions; choosing a project opens its board, where its tasks are.
The mode is remembered on each device, and in board mode the application opens on the
board. The list makes no requests of its own.

Column widths can be dragged and columns collapsed; Published starts collapsed. These
choices are remembered on each device. On a phone the board shows one stage at a
time. Task details open in a side panel.

Create a card with **+**: type its description, attach up to ten images (choose,
paste or drop them) and send it. Pressing the microphone and stopping the
recording sends the task at once with the typed text and images; the application
that received the recording transcribes it in the background, so the app can be
closed. The header microphone records a task without opening the dialog. A failed
transcription can be retried from the card. Rework comments in the task panel work
the same way. Until an agent takes a task, **Add more** in its panel appends text,
images and a recording to it in the same way (up to ten images per task); after that,
additions go to the task's session as rework. An agent assigns a category without asking questions. Questions about the work itself
appear in the execution session. There is no permanent board chat.

In CodexNest, classification runs in a temporary helper session that never appears
in the session list. If classification fails, use **Retry classification** in the
card to start a new attempt. Settings → New tasks can turn classification off for
tasks created in that application (their title is then the start of the task text,
without a category) and choose its model.

The initial stages are **To do → In progress → Waiting for answer → Ready →
Published**. Additional stages have a name and an optional description; they can be
renamed, moved and deleted (their tasks return to To do). Standard stages can be
renamed but keep their order. Boards created before this layout turn their Review
stage into Waiting for answer, and its tasks into Ready.

The application moves cards between In progress, Waiting for answer and Ready; the
agent never does. Dragging a card performs the step it represents: into In progress
it starts the agent, or sends a rework comment when the task already has a session;
from Ready into Published it publishes the task. A card waiting for an answer can be
moved to Ready by hand. Cards move freely to To do and custom stages, and reorder
within a stage; new and moved cards go to the top. A card stays put while its agent
works.

Idle tasks can be moved to the archive; published tasks move there automatically
after seven days. Restoring brings a task back. Deleting an archived task removes its
pictures and archives its sessions in the current application.

## Execution

Starting a card creates an ordinary session of the current application in the
project folder, with that application's new-session defaults. Its first message is
exactly the task text and pictures as the operator wrote them. There are no board
instructions, helper commands or reports: the agent follows the project's own rules as
in any session, including committing and pushing its work. Tasks share the project
folder, so the operator decides which tasks may run at the same time.

Several tasks can share one session: tick them in To do and press **Start together
(N)** in the column header, or drag one of the ticked tasks into In progress. The
first message then holds every task's text under its own heading («## Задача 1», …)
with all their pictures; the session uses the first settings chosen with them in
this application. From then on the tasks move together: a rework comment, **Start
again** and **Publish** on any of them go to that one session once and carry all of
them. The task panel lists the other tasks of its session.

The card follows the session:

- the session works — **In progress**;
- the agent asks through a question, an approval or a plan, or the session stops,
  fails or becomes unavailable — **Waiting for answer**, with the reason;
- a turn ends — the application's quick model (Haiku in ClaudeNest, the fastest
  subscription model in CodexNest, or the task check model chosen in Settings → New
  tasks) reads the agent's last message. A question,
  a request for a decision or a reported failure keeps the card in **Waiting for
  answer** with that question; otherwise the card goes to **Ready**;
- the operator answers in the session — back to **In progress**.

**Rework** sends a typed or dictated comment, with pictures, to the same session.
**Start again**, in the task's "…" menu, starts a new session with the original task
in the application where it was pressed; a working session of the same application
is stopped first. A session working in the other application cannot be replaced.

## Publication

An agent usually publishes its work itself. When it has not, or to wait for the checks,
**Publish** in a ready task's panel, dragging it to Published, or **Publish all** in
the Ready header sends the task's own session this message: «Опубликуй только на
GitHub: подтяни изменения с GitHub, разреши конфликты (если при этом правил код —
прогони тесты), запушь и дождись проверок GitHub Actions. Даже если по правилам
проекта публикация включает что-то ещё (деплой, обновление серверов или запущенных
приложений, релиз), сейчас ничего сверх GitHub не делай.» The agent publishes as it
would when asked in a normal session, under the repository's own rules, but only to
GitHub: where those rules also deploy or release, the board asks for none of that.
The card stays in
Ready, marked as being published. When the turn ends it moves to Published, or to
Waiting for answer if the agent asks something or reports failed checks. Several
publications run one after another, since they push the same branch from the same
folder. A task that never ran has nothing to publish and moves to Published at once.
The application itself checks neither Git nor GitHub.

## Shared storage and links

Boards, queued work and agent receipts live in
`~/.local/share/nest-apps/kanban`, outside project repositories. Set
`KANBAN_DATA_DIR` to use another shared directory; both applications must use the
same value. State is written atomically under interprocess locks. Restarting an
application preserves cards and queued continuations.

Session links use the current hostname with the default application ports
(`4310` for CodexNest and `4311` for ClaudeNest). Reverse proxies and custom ports
can override the sibling application addresses with `KANBAN_CODEX_URL` and
`KANBAN_CLAUDE_URL` on both servers.

Only task classification talks to the board, through a file-based helper limited to
reporting one card's title and category.
