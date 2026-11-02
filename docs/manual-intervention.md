# Manual intervention over noVNC

One page: how a human takes over a live micke session to do the thing the
agent must never do — type a credential, solve a CAPTCHA, make a judgment
call — and hand the desk back.

## The pause contract

1. **The agent announces the pause** — in its own words, to the human, naming
   the session: e.g. "I'm paused on session `a1b2c3d4` at the SSO login; I
   need a human to log in over noVNC."
2. **The human opens that session's noVNC URL** — from `session_list` (ready
   rows carry `novnc_url`) or the dashboard table at
   `http://127.0.0.1:7800/` (the default; `MICKE_PORT` changes it — one row
   per session, noVNC link in the last column). Both the dashboard and the
   noVNC URL are loopback-only, so the browser must run on (or tunnel to) the
   daemon host.
   The noVNC page shows and can drive the live desktop, but remote view is
   non-fatal: if x11vnc/websockify are not running, the session still reports
   `ready` and the URL can be dead; the agent can check `/tmp/x11vnc.log` and
   `/tmp/novnc.log` in the session.
3. **The human acts** — e.g. completes the SSO login. The credential goes
   from the human's fingers into the desktop, not through the agent: micke
   has no keylogger and no VNC-side input API, so the credential does not
   enter the transcript, a tool call, or micke's own logs. That is a property
   of this path, not an enforced guarantee — micke does not control the
   guest's x11vnc/websockify logs or the site you log into, and a secret
   pasted into chat is in the transcript.
4. **The human tells the agent to resume** — plain message: "logged in, go".
5. **The agent resumes and verifies via receipts**, never by trusting the
   human's word alone:

   ```bash
   agent-desktop wait --window "<expected post-login window title>" --app chromium --timeout 20000
   agent-desktop snapshot --app chromium -i --compact   # assert on refs/titles, then continue
   ```

## Input arbitration is a known hazard

The human and the agent share **one X display and one focused window**. There
is no arbitration: if the agent types or clicks while the human's hand is on
the keyboard, inputs interleave — keystrokes go to whatever has focus,
clicks land wherever the cursor is. This is unsolved by design in M-min.
**Intervene only while the agent is paused** (that is why the pause
announcement in step 1 names the session), and let the agent verify state
from receipts when it resumes rather than assuming nothing moved. "Paused"
is a promise from the agent, not daemon state: micke has no pause flag and
no human/agent input lock, so nothing enforces it.

## One copy-paste example prompt

Give this to the agent (adapt the trigger) to bind the behavior above:

> You are driving a micke session. ALL desktop interaction goes through the
> session's shell (`session_shell`) with `agent-desktop`. When you hit
> something only a human should do — an SSO/password prompt, a CAPTCHA, a
> payment confirmation, or a judgment call — do this, exactly:
> 1. Stop interacting with the desktop. Announce in your reply: "PAUSED on
>    session <id>: <what I need a human to do>", and include the session's
>    `novnc_url` so the human can open it.
> 2. Wait. Do not send input to that desktop until the human tells you they
>    are done.
> 3. When told to resume, verify the result yourself from receipts — e.g.
>    `agent-desktop wait --window "<expected title>" --app chromium` plus a
>    fresh `agent-desktop snapshot --app chromium -i --compact` — and only
>    then continue the task. If the verification fails, report what you see
>    instead of retrying blindly.
> Never ask the human to paste a credential, cookie, or token into the chat;
> the human types it directly into the desktop over noVNC.
