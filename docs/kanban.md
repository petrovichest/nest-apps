# Project boards

Each project has a board shared by the local CodexNest and ClaudeNest instances.
Open **Task board** from the project's menu, a session's actions or the board icon
in the session header. From a task's session the board opens with that task.
Both applications must run as the same operating-system user and resolve the
project to the same directory.

The navigation's Projects tab lists the projects with their menu, **+** and drag handle;
a project's name opens or folds it without closing the others, and the open projects
are remembered on each device (at first those not folded before stay open). Under an
open project are its board and its tasks: Waiting for answer and In progress first, then
the other stages in board order, with Published collapsed, and last **Sessions**: the
project's sessions that are not tasks on its board. Choosing a task opens its session,
in the other application when that one runs it, as the board's own link does; a task
without a session opens on the board. The Active tab still lists the active sessions.
The application opens on the board of the project shown last. Only the open projects'
boards are loaded: away from a project's board page the list asks for it every few
seconds, on that page it uses the board the page already loaded.

A session started with a project's **+** joins its board as a task in In progress and
moves on like any task. Its text is the first message; for a recorded first message the
application that runs the session reads it once recognised. The classifier names the
task and gives it a category but never splits a task that already has its session.

Column widths can be dragged and columns collapsed; Published starts collapsed. These
choices are remembered on each device. On a phone the board shows one stage at a
time. Choosing a task that has a session opens that session, in the other application
when that one runs it; its pencil opens the task's details in a side panel. A task
without a session opens its details directly.

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

When a new task holds several independent tasks of different categories, the
classifier splits it: the card keeps the first task and the others appear right
below it in To do. Each part gets the original sentences that belong to it, word for
word, its own images (an image the classifier does not assign goes to every part)
and the settings chosen with the task. A task whose text changed while it was being
classified is never split.

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
reporting one card's title and category, or the parts of a split task.
