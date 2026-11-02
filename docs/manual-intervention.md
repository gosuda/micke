# Manual intervention over noVNC (R2)

One page: how a human takes over a live micke session to do the thing the
agent must never do — type a credential, solve a CAPTCHA, make a judgment
call — and hand the desk back.

## The pause contract

1. **The agent announces the pause** — in its own words, to the human, naming
   the session: e.g. "I'm paused on session `a1b2c3d4` at the SSO login; I
   need a human to log in over noVNC."
2. **The human opens that session's noVNC URL** — from `session_list` (live
   rows carry `novnc_url`) or the dashboard table at
   `http://127.0.0.1:7800/` (one row per session, link in the last column).
   The browser shows and can drive the live desktop.
3. **The human acts** — e.g. completes the SSO login. The credential goes
   from the human's fingers into the desktop; it never enters any transcript,
   tool call, or log (micke has no keylogger and no input API on the VNC
   path — that's the point of doing it by hand).
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
from receipts when it resumes rather than assuming nothing moved.

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
