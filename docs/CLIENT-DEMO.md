# Showing VisionBot Pro to a client

A script for proving the five outcomes on a real phone, in about fifteen
minutes, and what each one needs connected. Everything below runs on the app
as it ships; nothing is staged. Where a result depends on a service, it says
which one, and where the app is careful about what it claims, it says how.

## The day before

1. **Run the check.** On the computer that runs the app:

   ```bash
   bash deploy/doctor.sh --live
   ```

   It costs a fraction of a cent. Every line should be a ✓. A ✗ says what to
   fix in plain words. The most common one is "out of credit": top up the
   Gemini project in Google AI Studio, because voice, Google search and store
   prices all run on that key.
2. **Open it on the phone you will demo with**, through its private https
   address (Tailscale Serve, START-HERE part 2), and add it to the home screen.
   For voice on the phone, LiveKit must be LiveKit Cloud (`wss://...`); the
   check says so if it is not.
3. **Add the people it will contact** on the Employee screen, each with "Who
   they are to you", for example `My contractor`. For the demo, make the
   "contractor" a phone you hold, or a colleague who has agreed: the text is
   real and goes to that number.
4. **Teach it two or three facts** you will ask about later: type
   `Remember that unit 4B has a Moen Posi-Temp shower valve` and send.
5. **Optional: let the client sign in themselves** with Google (README,
   "Signing in with Google"). They get an employee of their own, empty and kept
   apart from yours.

## The script

Start on the Today screen, signed in, with the camera on.

### 1. Less work on your phone: research by talking and showing

Tap **Start conversation**, point the camera at a product label or a fixture,
and say: *"What is this, and what does a replacement usually cost?"* It
answers out loud in a few seconds, from a Google search, and the answer
appears as a card on Today. Then say: *"Look up the installation steps and
send them to my tasks."* That becomes a task that keeps running while you keep
talking.

Needs: Gemini (with credit) and LiveKit. Without voice, type the same into
the question on Today with the camera on and tap "Ask about this photo": the
photo goes with it.

### 2. Faster purchasing: comparisons without visiting every site

Ask: *"Compare prices for a Moen 1222 shower cartridge."* Open the task under
Tasks. The comparison names every store it searched and which answered. It
shows each price with its link, and the cheapest first among equal matches.

What to say about it, because the client will ask:

- With only a Gemini key, prices for The Home Depot, Lowe's, Amazon and
  Walmart come from each store's own product page, found through Google. Each
  one is marked **Web search**: confirm it on the page, and buy it there. A
  price Google cannot tie to the store's own product page is left out rather
  than guessed.
- With a supplier's partner connection or your own supplier list
  (`docs/OWNER-ACTIONS.md`), its prices, stock and fulfillment come straight
  from the supplier. A supplier with a checkout connection can quote an exact
  total and take an order, after your approval.

### 3. Less coordination: texts, calls and purchases, with your approval

Ask: *"Text my contractor that the 4B shower valve needs a new cartridge this
week."* A card appears on Today: **Send this text**, with the exact words and
the exact number. Nothing is sent until you tap **Allow once**. Then the text
goes out, and the task lists it among what it did.

The same holds for a call (*"Call my contractor to confirm Tuesday at 10"*: you
approve the objective first) and for spending money (an exact supplier quote,
approved once).

Needs: Twilio for texts and Retell for calls, each with a number you own.
Replies and call results come back only when `PUBLIC_BASE_URL` is a public
https address.

### 4. Fewer forgotten tasks: work that continues on its own

While a task runs, close the app or lock the phone. Open it again: the task is
where it was, or done. **Tasks** lists every task with its status, what it
did, what it is waiting for, and its evidence: the photo, the comparison, the
texts it sent, a call's outcome and transcript. If the computer restarts mid-task, the task
says so and waits for **Resume**. An action whose outcome is unknown is never
repeated on its own.

### 5. Less repeated explanation: it remembers

Ask: *"What kind of shower valve is in unit 4B?"* It answers from what you
taught it the day before. The Employee screen shows what it remembers and who
it can contact, and you can change either.

## The flagship: a damaged fixture, handled while you keep walking

Point the camera at the damaged fixture and say, or type into "Ask about what
you see":

> Find a suitable replacement, compare prices, and prepare a message to my contractor.

What happens, in order:

1. The photo goes with the request as evidence. It works out what the fixture
   is from the photo, and from what the voice model saw.
2. It searches every connected store at once and saves the comparison to the
   task.
3. It finds the person whose role is "my contractor" and drafts a text naming
   the part, the best prices and what to do.
4. **Send this text** appears on Today with the exact words. You keep walking.
   In a voice conversation it tells you it is still on it, and the result
   follows when it is ready.
5. You approve when convenient. The text goes out, and the task ends with the
   recommendation and the links.

A task sent while the text waits for you starts as soon as you answer it. The
employee does one task at a time, and Today says so on the waiting task.

Verified end to end in the lab, on a phone-sized browser against the running
app: the photo, the four-store comparison, finding the contractor, the
approval, the text going out, and a second task running after the approval.
The lab stood in for Gemini, Twilio and the model, which was scripted
(`docs/TESTING.md`, "The damaged-fixture scenario"). Before the first client,
run it once yourself with real credit.

## What each outcome needs

| Outcome | Needs | Without it |
|---|---|---|
| Research by voice and camera | Gemini key with credit; LiveKit (Cloud for the phone) | Typing and photos still work |
| Store price comparisons | Gemini key (Google search), or supplier connections | It can read a store page you give it |
| Texts and calls | Twilio; Retell; a public https address for replies | It drafts; nothing is sent |
| Purchases | A supplier with a checkout connection | It compares; you buy on the store's site |
| Work that continues, memory | Nothing extra | — |
| Clients signing in themselves | Clerk keys | Access codes |

## Honest limits to state up front

- Store prices found by web search are what each store's page showed when
  Google read it. Stock, shipping and tax are confirmed on the store's site.
- It buys only through a supplier connection that quotes an exact total. It
  never presses a store website's "Place order" button. You can take over the
  browser and do that yourself.
- Texts and calls go only to people on your contact list, and only after you
  approve each one.
- It does one task at a time. A request made while it waits for you starts
  when you answer.
