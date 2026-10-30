/*
  The Mac's hands: anything that can be done in a web browser.

  "Order a watermelon", "find me finance internships", "put on a video about
  Peter Thiel". The phone hands over the goal; this drives the person's own
  Chrome — their own sign-ins, so Amazon already knows the address and the
  card — one step at a time: read the page, ask the model for the next move,
  make it, read again.

  THE MODEL PROPOSES; THIS FILE DECIDES. Two things it can never do alone:

  - Press anything that buys, sends, submits, books or deletes. A click whose
    label reads like one is turned into a confirmation here, whatever the
    model called it, and only an `approve` from the phone presses it — which
    the phone only sends after the person said yes to the summary they heard
    (mac.use in abilities.ts, behind the same `confirmed` the model is never
    given). The approval is for that one element on that one page: if the page
    moved in between, it asks again.
  - Type into a password or card field. Those are theirs to fill.

  A run stops to ask when it needs a detail ("which store?", "is this the
  right address?") and the task waits here, paused, for the answer. Every run
  is bounded at about a minute so the phone (which waits 88s) always gets a sentence
  back; a task that is not done by then asks whether to carry on rather than
  working on unwatched.
*/

import AppKit

struct AgentResult {
  /** "done", "ask", "confirm" or "failed". */
  let state: String
  let spoken: String
  let task: String
  var detail: String = ""
}

final class Agent {
  static let shared = Agent()

  private struct Pending { let n: Int; let url: String; let summary: String }
  private final class Task {
    let id: String
    let goal: String
    var history: [String] = []
    var steps = 0
    var confirm: Pending?
    var touched = Date()
    /** What the notch shows: short, human, never the engine's log. */
    var shown: [String] = []
    /** Recent moves, to notice going round in circles. */
    var moves: [String] = []
    /** How long a run may go before checking in: short for the phone, which is waiting on it. */
    var budget: TimeInterval = 60
    /** What they last said yes to, so the same press is never asked for twice. */
    var approved: String?
    /** A job done natively rather than in Chrome (a text), run on their yes. */
    var send: (() async -> String?)?
    /** People a name matched, while they pick one. */
    var choices: [Contact] = []
    var text = ""
    /** The steps it means to take, written on its first move and shown to it on every one after. */
    var plan = ""
    /** Its own Chrome tab, by id. */
    var tab = ""
    /** What the page looked like before the last move, to tell a move that worked from one that did nothing. */
    var seen = ""
    var acted = false
    init(id: String, goal: String) { self.id = id; self.goal = goal }
  }

  private var tasks: [String: Task] = [:]
  /** Set by Stop; every run checks it between moves. */
  private var stopping = false
  private(set) var running = false
  /**
    How Grove talks, from the phone. What it remembers about them is not sent
    with each move: the choice that needed it ("a film they'd like") was made
    once, when the ask was decided, and written into the goal. Forty moves
    each carrying the memory would cost forty times what one does.
  */
  var manner = ""

  /** "Stop", from the notch's button, the Mac's mic or the phone. */
  func stop() {
    Log.say("agent: stop")
    stopping = running
    tasks.removeAll()
  }
  /** Shown in the notch as it goes. */
  var onStep: ((String, [String]) -> Void)?

  private static let maxSteps = 60
  /** Labels that put something in a cart or an order. */
  private static let addWords = #"(?i)\b(quick add|add to (cart|bag|basket|order|trolley)|add \d+ to (order|cart)|add item)\b"#
  /** Labels that are the irreversible step, whatever the model calls them. */
  private static let finalWords = #"(?i)\b(place (your )?order|buy now|pay( now)?|complete (purchase|order|checkout)|confirm (order|purchase|payment|booking)|submit( order| application)?|send( now)?|book( now)?|reserve|delete|apply( now)?|checkout and pay|purchase)\b"#

  // MARK: entry points

  /**
    A new task always starts in a new tab. Starting on whatever was in front
    is how "text my brother" went to Instagram: the open tab was Instagram, so
    the model messaged him there, and typed into its search box.
  */
  func start(goal: String, budget: TimeInterval = 60) async -> AgentResult {
    tasks = tasks.filter { Date().timeIntervalSince($0.value.touched) < 600 }
    let task = Task(id: String(UUID().uuidString.prefix(8)).lowercased(), goal: goal)
    task.budget = budget
    tasks[task.id] = task
    Log.say("agent: start \(task.id) \(goal)")
    if let failure = await Browser.ready() { return AgentResult(state: "failed", spoken: failure, task: task.id) }
    await Browser.newTab()
    task.tab = Browser.tab
    return await loop(task)
  }

  /**
    A text goes through Messages, not a website. The person is found in
    Contacts — by name, or by what they are to them ("my brother", from the
    related names on their own card) — and the exact words are read back
    before anything is sent, with the same yes as everything else here.
  */
  func message(to who: String, text: String) async -> AgentResult {
    let task = Task(id: String(UUID().uuidString.prefix(8)).lowercased(), goal: "Text \(who)")
    task.text = text
    task.history = [who]
    tasks[task.id] = task
    Log.say("agent: message \(task.id) to \(who)")
    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
      return AgentResult(state: "failed", spoken: "What should the message to \(who) say?", task: task.id)
    }
    let found = await Contacts.find(who)
    if Contacts.refused {
      tasks[task.id] = nil
      return AgentResult(state: "failed", spoken: "Your Mac hasn't let me look in Contacts. System Settings, Privacy and Security, Automation: under Grove, turn on Contacts and Messages.", task: task.id)
    }
    if found.isEmpty {
      tasks[task.id] = nil
      let relation = Contacts.isRelation(who)
      return AgentResult(state: "failed", spoken: relation
        ? "I don't know who your \(who.lowercased().replacingOccurrences(of: "my ", with: "")) is yet. Say their name, and I'll remember."
        : "I couldn't find \(who) in your Contacts on this Mac.", task: task.id)
    }
    if found.count > 1 {
      task.choices = found
      let names = found.prefix(3).map(\.name).joined(separator: ", or ")
      return AgentResult(state: "ask", spoken: "Which one: \(names)?", task: task.id)
    }
    return confirmText(task, to: found[0])
  }

  private func confirmText(_ task: Task, to person: Contact) -> AgentResult {
    let text = task.text
    task.send = { await Messages.send(text, to: person.address) }
    task.confirm = Pending(n: -1, url: "", summary: "")
    return AgentResult(state: "confirm", spoken: "Text \(person.name): “\(text)”. Send it?", task: task.id)
  }

  /** Their answer to a question, or `approve` after a yes to a confirmation. */
  func resume(task id: String, answer: String, approve: Bool) async -> AgentResult {
    guard let task = tasks[id] else {
      return AgentResult(state: "failed", spoken: "I lost track of that one on your Mac. Ask me again?", task: id)
    }
    task.touched = Date()
    if !task.choices.isEmpty {
      let said = answer.lowercased()
      let picked = task.choices.first { said.contains($0.name.lowercased()) }
        ?? task.choices.first { $0.name.lowercased().split(separator: " ").contains { said.contains($0) && $0.count > 2 } }
        ?? (said.contains("first") ? task.choices.first : nil)
      guard let picked else { return AgentResult(state: "ask", spoken: "Which one? \(task.choices.prefix(3).map(\.name).joined(separator: ", or ")).", task: task.id) }
      task.choices = []
      // Asked once: next time "Akash" or "my brother" means this one.
      if let who = task.history.first { Contacts.remember(who, picked) }
      return confirmText(task, to: picked)
    }
    if let send = task.send {
      tasks[id] = nil
      guard approve else { return AgentResult(state: "done", spoken: "Okay, I won't send it.", task: id) }
      if let failure = await send() { return AgentResult(state: "failed", spoken: failure, task: id) }
      return AgentResult(state: "done", spoken: "Sent.", task: id)
    }
    if approve, let pending = task.confirm {
      task.confirm = nil
      let page = await Browser.url()
      guard page == pending.url else {
        task.history.append("The page changed before the press; confirm again before pressing anything.")
        return await loop(task)
      }
      let result = await Browser.js(Browser.clickJS(pending.n))
      task.approved = pending.summary
      task.history.append("They said yes and it was pressed: \(pending.summary) → \(result). That step is finished; never do it again. If the goal is now reached, reply done.")
      Log.say("agent: approved \(task.id) \(pending.summary)")
      try? await _Concurrency.Task.sleep(nanoseconds: 2_000_000_000)
    } else {
      task.confirm = nil
      task.history.append("They said: \(answer)")
    }
    return await loop(task)
  }

  // MARK: the loop

  private func loop(_ task: Task) async -> AgentResult {
    running = true
    stopping = false
    defer { running = false; stopping = false }
    let started = Date()
    if !task.tab.isEmpty { Browser.tab = task.tab }
    if let failure = await Browser.ready() { return AgentResult(state: "failed", spoken: failure, task: task.id) }

    while Date().timeIntervalSince(started) < task.budget {
      if stopping { return AgentResult(state: "stopped", spoken: "Stopped.", task: task.id) }
      guard task.steps < Agent.maxSteps else {
        return AgentResult(state: "failed", spoken: "I went round in circles on your Mac and stopped. It's on the page I got to.", task: task.id)
      }
      task.steps += 1
      var page = await Browser.read()
      // A page that could not be read is not an empty page. Acting on one is
      // how "you're not signed in" came back for someone who was: Chrome had
      // refused the read, and the model guessed from nothing.
      if page.error != nil {
        try? await _Concurrency.Task.sleep(nanoseconds: 1_500_000_000)
        page = await Browser.read()
      }
      if let error = page.error {
        tasks[task.id] = nil
        if error.lowercased().contains("javascript") {
          return AgentResult(state: "failed", spoken: "Chrome stopped letting me read the page. Each Chrome profile has its own switch: in the window that's open, View, Developer, Allow JavaScript from Apple Events.", task: task.id)
        }
        return AgentResult(state: "failed", spoken: "I couldn't read that page in Chrome, so I stopped rather than guess.", task: task.id)
      }
      // Every move is checked against the page it was meant to change. Without
      // this the model only ever saw the new page, never whether its click had
      // done anything — so a press that missed looked the same as one that
      // worked, and it carried on as though the message had been typed.
      let seen = "\(page.url)|\(page.title)|\(page.board)|\(page.text)|" + page.items.map { "\($0["label"] ?? "")=\($0["value"] ?? "")\($0["state"] ?? "")" }.joined()
      if task.acted && seen == task.seen {
        task.history.append("Result: nothing on the page changed after that move. It did not work; try a different element or way.")
      }
      task.seen = seen
      task.acted = false
      // Thinking is billed as output, the dearest kind of token, so it is
      // spent where a move is genuinely hard: the first move (the plan), a
      // board to reason about, and recovering from a move that did nothing.
      // An ordinary click on an ordinary page does not need it.
      let recent = task.history.suffix(2).joined()
      let hard = task.steps == 1 || !page.board.isEmpty || recent.contains("nothing on the page changed") || recent.contains("already did")
      guard let move = await Agent.next(goal: task.goal, plan: task.plan, history: task.history, page: page, manner: manner, think: hard) else {
        return AgentResult(state: "failed", spoken: "I couldn't work out the next step on your Mac.", task: task.id)
      }
      // Stop pressed while the model was thinking: the move it came back with is not made.
      if stopping { return AgentResult(state: "stopped", spoken: "Stopped.", task: task.id) }
      let action = (move["action"] as? String ?? "").lowercased()
      let n = (move["n"] as? Int) ?? Int("\(move["n"] ?? "")") ?? -1
      let text = move["text"] as? String ?? ""
      let label = Agent.label(of: n, in: page)
      Log.say("agent: \(task.id) \(action) \(n) \(label.prefix(40)) \(text.prefix(60))")

      // The same move on the same thing, again: the page is not doing what the
      // model expects. Twice is a hint to try something else; a third time is
      // a loop, and it stops and says so rather than clicking for ever.
      let signature = "\(action)|\(label)|\(move["url"] ?? "")|\(text)"
      task.moves.append(signature)
      if task.moves.count > 6 { task.moves.removeFirst() }
      let repeats = task.moves.filter { $0 == signature }.count
      if repeats >= 3 && action != "scroll" && action != "wait" && action != "keys" {
        task.history.append("Stuck: tried \(action) on \(label) three times.")
        return AgentResult(state: "ask", spoken: "I'm going in circles on \(page.title.isEmpty ? "this page" : page.title). What should I pick?", task: task.id)
      }
      if repeats == 2 && action != "scroll" && action != "wait" {
        task.history.append("You already did \(action) on \(label) and the page did not change the way you wanted. Do something different, or ask them.")
      }
      if let said = move["step"] as? String, !said.isEmpty { show(task, said) }
      if task.plan.isEmpty, let plan = move["plan"] as? String { task.plan = plan }
      if ["click", "type", "keys", "select"].contains(action) { task.acted = true }

      switch action {
      case "go":
        let url = move["url"] as? String ?? ""
        await Browser.go(url)
        task.history.append("Went to \(url)")
      case "click":
        // Putting something in a cart is a choice, and theirs: "is this the
        // one?" before it goes in, with the same yes as a payment. Told this in
        // the prompt, the model still quick-added a burger nobody picked.
        if label.range(of: Agent.addWords, options: .regularExpression) != nil {
          // The question names what goes in, because "adding the burger" was
          // what came back and that is not a thing anyone can say yes to.
          var said = ((move["summary"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
          if said.isEmpty || !said.hasSuffix("?") {
            said = "\(said.isEmpty ? "Adding to your cart" : said.trimmingCharacters(in: CharacterSet(charactersIn: ".")))\(label.isEmpty ? "" : " (\(label.prefix(60)))"). Is that the one?"
          }
          return askToConfirm(task, n: n, url: page.url, summary: said)
        }
        if label.range(of: Agent.finalWords, options: .regularExpression) != nil {
          return askToConfirm(task, n: n, url: page.url, summary: (move["summary"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Press \(label)?", label: label)
        }
        let r = await Browser.js(Browser.clickJS(n))
        task.history.append("Clicked [\(n)] \(label) → \(r)")
        try? await _Concurrency.Task.sleep(nanoseconds: 1_500_000_000)
      case "keys":
        // Real key presses, for pages that listen to the keyboard rather than
        // a box — a game board, a shortcut. Typed into a field, Wordle saw
        // nothing; pressed, it fills the row.
        await Browser.keys(text, enter: (move["enter"] as? Bool) ?? false)
        task.history.append("Pressed keys \"\(text)\"\((move["enter"] as? Bool) == true ? " then Return" : "")")
        try? await _Concurrency.Task.sleep(nanoseconds: 2_500_000_000)
      case "type":
        if Agent.isSecret(n, in: page) {
          task.history.append("Refused to type into [\(n)]: password and card fields are theirs to fill.")
          continue
        }
        let r = await Browser.js(Browser.typeJS(n, text))
        if (move["enter"] as? Bool) == true { await Browser.pressReturn() }
        task.history.append("Typed \"\(text)\" into [\(n)] \(label) → \(r)")
        try? await _Concurrency.Task.sleep(nanoseconds: 1_500_000_000)
      case "select":
        let r = await Browser.js(Browser.selectJS(n, text))
        task.history.append("Chose \"\(text)\" in [\(n)] → \(r)")
      case "scroll":
        _ = await Browser.js("window.scrollBy(0, innerHeight * 0.8); 'ok'")
        task.history.append("Scrolled down")
      case "back":
        _ = await Browser.js("history.back(); 'ok'")
        task.history.append("Went back")
        try? await _Concurrency.Task.sleep(nanoseconds: 1_200_000_000)
      case "wait":
        try? await _Concurrency.Task.sleep(nanoseconds: 2_000_000_000)
        task.history.append("Waited")
      case "ask":
        let q = (move["question"] as? String) ?? text
        task.history.append("Asked them: \(q)")
        return AgentResult(state: "ask", spoken: q, task: task.id)
      case "confirm":
        return askToConfirm(task, n: n, url: page.url, summary: (move["summary"] as? String) ?? text, label: label)
      case "done":
        tasks[task.id] = nil
        let said = (move["summary"] as? String) ?? text
        return AgentResult(state: "done", spoken: said.isEmpty ? "Done on your Mac." : said, task: task.id, detail: page.url)
      default:
        tasks[task.id] = nil
        let said = (move["summary"] as? String) ?? text
        return AgentResult(state: "failed", spoken: said.isEmpty ? "I couldn't do that on your Mac." : said, task: task.id)
      }
      if task.history.count > 30 { task.history.removeFirst(task.history.count - 30) }
    }
    task.history.append("Paused to check in with them.")
    return AgentResult(state: "ask", spoken: "I'm partway through on your Mac. Keep going?", task: task.id)
  }

  /**
    The yes is asked for the thing that will actually be pressed. The model's
    summary said "Sending message to Akash" over a button labelled with
    somebody else's post; naming the button too is what makes that visible.
    And a press already said yes to is never asked for again: that was a
    message sent, then the same send offered a second time.
  */
  private func askToConfirm(_ task: Task, n: Int, url: String, summary: String, label: String = "") -> AgentResult {
    if let approved = task.approved, approved == summary {
      tasks[task.id] = nil
      return AgentResult(state: "done", spoken: "Done.", task: task.id, detail: url)
    }
    var said = summary
    let button = label.trimmingCharacters(in: .whitespacesAndNewlines)
    if !button.isEmpty && !said.lowercased().contains(button.lowercased().prefix(20)) {
      said += " (presses “\(button.prefix(40))”)"
    }
    task.confirm = Pending(n: n, url: url, summary: summary)
    task.history.append("Stopped for their yes: \(summary)")
    return AgentResult(state: "confirm", spoken: said, task: task.id)
  }

  /** A new line in the notch, unless it says what the last one said. */
  private func show(_ task: Task, _ line: String) {
    let clean = String(line.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
    guard clean != task.shown.last else { return }
    task.shown.append(clean)
    let recent = Array(task.shown.suffix(3))
    DispatchQueue.main.async { self.onStep?(task.goal, recent) }
  }

  // MARK: reading the page

  private static func label(of n: Int, in page: Browser.Page) -> String {
    page.items.first { ($0["n"] as? Int) == n }.flatMap { $0["label"] as? String } ?? ""
  }

  private static func isSecret(_ n: Int, in page: Browser.Page) -> Bool {
    guard let item = page.items.first(where: { ($0["n"] as? Int) == n }) else { return false }
    let kind = "\(item["type"] ?? "") \(item["auto"] ?? "") \(item["label"] ?? "")".lowercased()
    return kind.contains("password") || kind.contains("cc-") || kind.range(of: #"card number|cvv|cvc|security code"#, options: .regularExpression) != nil
  }

  // MARK: the model

  private static let brief = """
  You are Grove, using the person's own Mac and their Chrome browser to do what they asked. They are signed in to their usual sites.
  Each turn you see the goal, what has happened so far, and the current page: its address, numbered things you can press or type into (with their state when they have one), the state of any board or grid on it, and some of its text.
  You start in a new empty tab: open the right site first. Use only the site they named, or the obvious one for the job; never do it somewhere else because that happened to be open.
  Before choosing, look at what the last move actually did ("Result" lines in So far, and the page itself) and at your plan. On your first move only, also include "plan": the three to six steps you will take, in one line.
  Reply with ONE next move as JSON. Every move also carries "step": what you are doing, as a person would say it in four to seven words, e.g. "Searching Amazon for watermelon", "Adding it to your cart", "Opening checkout". Never numbers, brackets or button names in step.
  {"action":"go","url":"https://..."} — open an address. Go straight to search addresses when you can: https://www.youtube.com/results?search_query=..., https://www.google.com/search?q=..., https://www.amazon.com/s?k=..., https://www.linkedin.com/jobs/search/?keywords=..., https://www.indeed.com/jobs?q=...
  {"action":"click","n":12,"summary":"..."} — when the click puts something in a cart or an order, summary is the question they will answer: the item, how many and the price, e.g. "One OG Cheeseburger from Burger's Priest, $11.99. Add it to your order?" Check the quantity is what they asked for (one, unless they said more) before adding.
  {"action":"type","n":4,"text":"...","enter":true}
  {"action":"keys","text":"crane","enter":true} — real key presses, for pages that listen to the keyboard rather than a box: games like Wordle, shortcuts. Not for typing into a field.
  {"action":"select","n":7,"text":"option"}
  {"action":"scroll"} {"action":"back"} {"action":"wait"}
  {"action":"ask","question":"..."} — only when you cannot go on without them: a detail only they know, or a choice that is theirs and costs money (which item, which size, which restaurant). One short spoken question.
  {"action":"confirm","n":31,"summary":"..."} — before anything that buys, sends, submits, books, applies or deletes. The summary is read aloud and they answer yes or no: say exactly what will happen, with the item, the price and total if shown, and where it goes, e.g. "Placing the order: one whole watermelon, $5.49, total $9.12, to 12 King Street. Go ahead?"
  {"action":"done","summary":"..."} — the goal is reached. One or two sentences, said as their friend rather than a receipt: what is on their screen, and why you picked it or a light remark when there is one to make, e.g. "Peter Thiel on Competition is on. Fair warning, he'll talk you out of starting a restaurant."
  {"action":"fail","summary":"..."} — it cannot be done; say why plainly.
  Rules:
  - Orders: before checkout, ask them to confirm the delivery address and the item you picked if either was not stated. Never change payment details. Never press the final button with click; use confirm.
  - Never type into password or card fields. If a sign-in is needed, ask them to sign in on the Mac and say when they have.
  - Asking interrupts them, so it is rare. Never ask to check something they already said, whether to carry on, "is this right?" about anything that costs nothing, or in the middle of a step. Pick the obvious choice yourself for things that cost nothing: the first good video, the top results, the usual site.
  - Say done only for what you did in this task, or for what you were asked to look at. A result already on the page when you arrived (a finished game, an old order) is not your result: start a new one, or say plainly that it was already like that.
  - When "So far" says they said yes and it was pressed, that step is finished. Look at the page: if the goal is reached, reply done. Never press, type or send it again.
  - Games and puzzles (Wordle and the like): read the board's states carefully before every guess. A letter marked correct stays in that exact position; present means it is in the word but not in that position; absent means it is not in the word at all, so never use it again. Work out every constraint, then guess a real English word that satisfies all of them. One guess per move: keys with the whole word and enter true. Never press an on-screen keyboard key by key. Close any help or welcome dialog first.
  - Food and shopping: if they did not name the exact item or restaurant, ask, offering the best two or three by name and price ("Smash Burger Co, $14, or Five Guys, $16?"). Never use quick-add on something they did not choose. Ignore existing carts unless they mention them.
  - For looking things up (jobs, reviews, prices), finish on the page that shows them and summarise the best two or three in done.
  - Do not repeat a move that just failed; try another way.
  - Never say they are not signed in unless the page plainly shows a sign-in form asking for their email or password. If unsure, wait and look again.
  - Email: Gmail is https://mail.google.com/mail/u/0/#inbox and searches as https://mail.google.com/mail/u/0/#search/QUERY with Gmail operators, e.g. replies since yesterday: in:inbox newer_than:2d; what they sent: in:sent newer_than:2d. Read the list and say who wrote and about what. For "did anyone reply to what I sent": first in:sent for that day to see who they wrote to, then search the inbox for replies from those people (e.g. in:inbox newer_than:2d -from:me), and say who replied and who has not yet. Open an email if the list does not show enough.
  - Messages: Instagram DMs are at https://www.instagram.com/direct/inbox/. Reading is fine without asking; summarise who wrote and what in done. Never send a message without confirm. To send one: open the conversation with that person, type into the message box (not the search box), then confirm on the Send button.
  JSON only.
  """

  private static func next(goal: String, plan: String, history: [String], page: Browser.Page, manner: String, think: Bool) async -> [String: Any]? {
    let info = Bundle.main.infoDictionary ?? [:]
    guard let key = info["GroveGeminiKey"] as? String, !key.isEmpty else { return nil }
    let light = (info["GroveModel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "gemini-flash-lite-latest"

    // Each thing on the page once: a button's label is already listed, so its
    // line is dropped from the text, which on most pages is half the text.
    let labels = Set(page.items.compactMap { ($0["label"] as? String)?.lowercased() })
    let text = page.text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty && !labels.contains($0.lowercased()) }.joined(separator: "\n").prefix(2000)
    let items = page.items.map { item -> String in
      var s = "[\(item["n"] ?? "")] \(item["tag"] ?? "")"
      if let t = item["type"] as? String, !t.isEmpty { s += "(\(t))" }
      s += " \(item["label"] ?? "")"
      if let v = item["value"] as? String, !v.isEmpty { s += " = \"\(v)\"" }
      if let st = item["state"] as? String, !st.isEmpty { s += " {\(st)}" }
      return s
    }.joined(separator: "\n")
    let prompt = """
    \(manner.isEmpty ? "" : "Your manner, for done, ask and confirm lines only (style, never a reason to change what you do): \(manner.prefix(300))\n")
    Goal: \(goal)
    \(plan.isEmpty ? "" : "Your plan: \(plan)\n")
    So far:
    \(history.isEmpty ? "(nothing yet)" : history.suffix(14).joined(separator: "\n"))

    Page: \(page.title)
    Address: \(page.url)
    Things on it:
    \(items.isEmpty ? "(none)" : items)
    \(page.board.isEmpty ? "" : "\nBoard:\n" + page.board)

    Text:
    \(text)
    """

    /*
      The full flash model rather than the lite one every other call uses,
      thinking only on the hard moves (see `hard` in the loop). A move is a judgement about a page — which of forty buttons, which
      word fits five clues — and the lite model was what typed a message into a
      search box and played Wordle with letters it had already been told were
      wrong. Measured at under a second a move; the lite one is the fallback.
    */
    for (model, thinking) in [("gemini-flash-latest", think), (light, false)] {
      guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent") else { continue }
      var request = URLRequest(url: url, timeoutInterval: 30)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
      var config: [String: Any] = ["responseMimeType": "application/json", "maxOutputTokens": thinking ? 4000 : 400, "temperature": 0.2]
      config["thinkingConfig"] = ["thinkingBudget": thinking ? 1024 : 0]
      let body: [String: Any] = [
        "systemInstruction": ["parts": [["text": brief]]],
        "contents": [["role": "user", "parts": [["text": prompt]]]],
        "generationConfig": config,
      ]
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
      guard let (data, response) = try? await URLSession.shared.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200,
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let content = (root["candidates"] as? [[String: Any]])?.first?["content"] as? [String: Any],
            let raw = (content["parts"] as? [[String: Any]])?.compactMap({ $0["text"] as? String }).first,
            let json = raw.data(using: .utf8),
            let move = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
      else { continue }
      return move
    }
    return nil
  }
}

struct Contact { let name: String; let address: String }

/** People, from the Contacts app on this Mac. */
enum Contacts {
  private static let relations: [String: [String]] = [
    "mom": ["mother", "mom", "mum"], "mum": ["mother", "mom", "mum"], "mother": ["mother", "mom", "mum"],
    "dad": ["father", "dad"], "father": ["father", "dad"],
    "brother": ["brother"], "sister": ["sister"], "wife": ["spouse", "wife"], "husband": ["spouse", "husband"],
    "partner": ["partner", "spouse"], "girlfriend": ["partner", "girlfriend"], "boyfriend": ["partner", "boyfriend"],
    "son": ["child", "son"], "daughter": ["child", "daughter"],
  ]

  /** "Akash ( Baby Groot 🌴 )" is read aloud as "Akash, Baby Groot". */
  static func sayable(_ name: String) -> String {
    var scalars = String.UnicodeScalarView()
    for u in name.unicodeScalars where !u.properties.isEmojiPresentation && u.value != 0xFE0F { scalars.append(u) }
    return String(scalars)
      .replacingOccurrences(of: #"\s*\(\s*"#, with: ", ", options: .regularExpression)
      .replacingOccurrences(of: #"\s*\)\s*"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
  }

  private static func key(_ who: String) -> String {
    "grove.contact." + who.lowercased().replacingOccurrences(of: #"^(my|our)\s+"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  }
  static func isRelation(_ who: String) -> Bool { relations[String(key(who).dropFirst("grove.contact.".count))] != nil }
  static func remember(_ who: String, _ person: Contact) {
    UserDefaults.standard.set([person.name, person.address], forKey: key(who))
  }

  /** The last lookup was refused by macOS, not empty: -1743, Automation not allowed. */
  static var refused = false

  /** Everyone the words could mean, most likely first; one entry when it is clear. */
  static func find(_ who: String) async -> [Contact] {
    refused = false
    if let saved = UserDefaults.standard.stringArray(forKey: key(who)), saved.count == 2 {
      return [Contact(name: saved[0], address: saved[1])]
    }
    var name = String(key(who).dropFirst("grove.contact.".count))
    // "my brother": whoever their own card names as their brother.
    if let labels = relations[name] {
      let (_, out) = await Browser.run("""
      tell application "Contacts"
        set out to ""
        repeat with r in related names of my card
          set out to out & (label of r) & tab & (value of r) & linefeed
        end repeat
        return out
      end tell
      """)
      let match = out.split(separator: "\n").map { $0.split(separator: "\t", maxSplits: 1).map(String.init) }
        .first { pair in pair.count == 2 && labels.contains { pair[0].lowercased().contains($0) } }
      guard let match else { return [] }
      name = match[1].lowercased()
    }
    let quoted = "\"" + name.replacingOccurrences(of: "\"", with: "") + "\""
    let (ok, out) = await Browser.run("""
    tell application "Contacts"
      set out to ""
      repeat with p in (every person whose name contains \(quoted))
        set addr to ""
        if (count of phones of p) > 0 then
          set addr to value of first phone of p
        else if (count of emails of p) > 0 then
          set addr to value of first email of p
        end if
        if addr is not "" then set out to out & (name of p) & tab & addr & linefeed
      end repeat
      return out
    end tell
    """)
    if !ok { refused = out.lowercased().contains("not authorized") || out.lowercased().contains("not allowed"); return [] }
    let all = out.split(separator: "\n").compactMap { line -> Contact? in
      let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
      // Names said aloud: "Akash ( Baby Groot 🌴 )" is read as "Akash, Baby Groot".
      let spoken = Contacts.sayable(parts.first ?? "")
      return parts.count == 2 ? Contact(name: spoken, address: parts[1]) : nil
    }
    // A whole name, or a first name said exactly, beats one that only contains it.
    let exact = all.filter { $0.name.lowercased() == name || $0.name.lowercased().hasPrefix(name + " ") }
    return exact.isEmpty ? all : exact
  }
}

/** Texts, through the Messages app: iMessage, then SMS through the iPhone. */
enum Messages {
  /** nil when it went; otherwise what to say. */
  static func send(_ text: String, to address: String) async -> String? {
    func q(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
    let (ok, out) = await Browser.run("""
    tell application "Messages"
      try
        set svc to 1st account whose service type = iMessage
        send \(q(text)) to participant \(q(address)) of svc
        return "sent"
      on error
        set svc to 1st account whose service type = SMS
        send \(q(text)) to participant \(q(address)) of svc
        return "sent"
      end try
    end tell
    """)
    Log.say("messages: \(ok ? out : "failed " + out)")
    return ok && out == "sent" ? nil : "Messages wouldn't send it. Check you're signed in to Messages on this Mac."
  }
}

/*
  Chrome, through AppleScript: an address to go to, and JavaScript run in the
  front tab. Chrome refuses the JavaScript until "Allow JavaScript from Apple
  Events" is ticked in View › Developer. That is a security setting, so it is
  theirs to tick: Grove says exactly where it is and never flips it itself.
*/
enum Browser {
  struct Page {
    var url = ""
    var title = ""
    var items: [[String: Any]] = []
    var text = ""
    /** Tiles and cells with a state — a game board, a grid — read out, since their text alone says nothing. */
    var board = ""
    /** Why the page could not be read, when it could not. */
    var error: String?
  }

  static func run(_ source: String) async -> (Bool, String) {
    await withCheckedContinuation { c in Script.run(source) { ok, out in c.resume(returning: (ok, out)) } }
  }

  private static func quoted(_ s: String) -> String {
    "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: " ") + "\""
  }

  /** nil when Chrome is ready to be driven; otherwise the sentence to say. */
  static func ready() async -> String? {
    _ = await run("""
    tell application "Google Chrome"
      activate
      if (count of windows) is 0 then make new window
    end tell
    """)
    let (ok, out) = await run("tell application \"Google Chrome\" to execute \(tab) javascript \"'ok'\"")
    if ok && out == "ok" { return nil }
    if out.lowercased().contains("javascript") {
      return "One thing first, in Chrome on your Mac: View, Developer, then tick Allow JavaScript from Apple Events. Then ask me again."
    }
    return "I couldn't control Chrome. Allow Grove under Automation in System Settings, from the Grove menu's checklist."
  }

  static func go(_ url: String) async {
    var s = url.trimmingCharacters(in: .whitespaces)
    if !s.contains("://") { s = "https://" + s }
    _ = await run("tell application \"Google Chrome\" to set URL of \(tab) to \(quoted(s))")
    for _ in 0..<20 {
      try? await _Concurrency.Task.sleep(nanoseconds: 400_000_000)
      let (_, loading) = await run("tell application \"Google Chrome\" to get loading of \(tab)")
      if loading == "false" { break }
    }
    try? await _Concurrency.Task.sleep(nanoseconds: 800_000_000)
  }

  /**
    The tab a task works in, by id. Following "the active tab of the front
    window" meant following wherever their attention went: they clicked into
    another Chrome window — another profile, where JavaScript from Apple
    Events was off — and every read after that was refused mid-Wordle.
  */
  static var tab = "active tab of front window"

  static func newTab() async {
    let (ok, out) = await run("""
    tell application "Google Chrome"
      set w to front window
      set t to make new tab at end of tabs of w
      return ((id of w) as string) & "," & ((id of t) as string)
    end tell
    """)
    let ids = out.split(separator: ",")
    tab = ok && ids.count == 2 ? "tab id \(ids[1]) of window id \(ids[0])" : "active tab of front window"
    try? await _Concurrency.Task.sleep(nanoseconds: 300_000_000)
  }

  /** Brings the task's own tab to the front, for key presses, which go to whatever is frontmost. */
  static func front() async {
    guard tab != "active tab of front window" else { return }
    let parts = tab.components(separatedBy: " of window id ")
    guard parts.count == 2, let tabID = parts[0].split(separator: " ").last else { return }
    _ = await run("""
    tell application "Google Chrome"
      set w to window id \(parts[1])
      set index of w to 1
      repeat with i from 1 to (count of tabs of w)
        if (id of tab i of w) as string is "\(tabID)" then set active tab index of w to i
      end repeat
      activate
    end tell
    """)
  }

  /**
    Key presses into the page. First as events sent into the tab itself, which
    needs nothing in front and costs nothing; then, only if the page did not
    change, as real presses through System Events, which go to whatever window
    is frontmost. Relying on the real ones alone, a press that landed somewhere
    else made the model fall back to clicking an on-screen keyboard one letter
    at a time, a paid move per letter.
  */
  // Sent once, to the focused element or the document: it bubbles up to the
  // window on its own, and sending it to both typed every letter twice.
  static func keys(_ text: String, enter: Bool) async {
    let before = await read()
    let keys = (try? String(data: JSONSerialization.data(withJSONObject: text.map { String($0) } + (enter ? ["Enter"] : [])), encoding: .utf8)) ?? "[]"
    _ = await js("""
    (function(){var ks=\(keys);var t=document.activeElement&&document.activeElement!==document.body&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)?document.activeElement:document;
    ks.forEach(function(k){var o={key:k,code:k==='Enter'?'Enter':'Key'+k.toUpperCase(),keyCode:k==='Enter'?13:k.toUpperCase().charCodeAt(0),which:k==='Enter'?13:k.toUpperCase().charCodeAt(0),bubbles:true,cancelable:true,composed:true};
    t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));});return 'ok';})()
    """)
    try? await _Concurrency.Task.sleep(nanoseconds: 600_000_000)
    let after = await read()
    if after.board != before.board || after.text != before.text { return }
    _ = await js("(function(){if(document.activeElement&&document.activeElement!==document.body)document.activeElement.blur();return 'ok';})()")
    await front()
    _ = await run("tell application \"Google Chrome\" to activate")
    try? await _Concurrency.Task.sleep(nanoseconds: 300_000_000)
    for ch in text {
      _ = await run("tell application \"System Events\" to keystroke \(quoted(String(ch)))")
      try? await _Concurrency.Task.sleep(nanoseconds: 90_000_000)
    }
    if enter { _ = await run("tell application \"System Events\" to key code 36") }
  }

  static func url() async -> String {
    await run("tell application \"Google Chrome\" to get URL of \(tab)").1
  }

  static func js(_ code: String) async -> String {
    let (ok, out) = await run("tell application \"Google Chrome\" to execute \(tab) javascript \(quoted(code))")
    if !ok { lastError = out }
    return ok ? out : "error"
  }
  /** The last thing Chrome said when it refused. */
  static var lastError = ""

  static func pressReturn() async {
    await front()
    _ = await run("tell application \"System Events\" to key code 36")
    try? await _Concurrency.Task.sleep(nanoseconds: 1_500_000_000)
  }

  /** Numbers what can be pressed or typed into, and returns it with the page's text. */
  // Into shadow roots too: web components (a game board, half of YouTube) keep
  // their insides there, and a reader that stops at the light DOM sees an
  // empty page where the whole thing is. No // comments inside the script:
  // it is sent as one line, and the first one would swallow the rest.
  static func read() async -> Page {
    let code = """
    (function(){
      var sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick]';
      function all(q){var out=[];(function walk(root){root.querySelectorAll(q).forEach(function(e){out.push(e);});
        root.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)walk(e.shadowRoot);});})(document);return out;}
      function deepText(root){var t='';root.childNodes.forEach(function(c){
        if(c.nodeType===3)t+=c.textContent; else if(c.nodeType===1){var st=getComputedStyle(c); if(st.display==='none'||st.visibility==='hidden')return;
        if(c.shadowRoot)t+=' '+deepText(c.shadowRoot)+' '; if(/^(SCRIPT|STYLE|NOSCRIPT)$/.test(c.tagName))return; t+=deepText(c); if(/^(DIV|P|LI|TR|H[1-6]|SECTION|ARTICLE|BR)$/.test(c.tagName))t+='\\n';}});return t;}
      all('[data-grove]').forEach(function(e){e.removeAttribute('data-grove');});
      window.__grove=[];
      var out=[],n=0,h=innerHeight;
      all(sel).forEach(function(e){
        if(n>=140)return;
        var r=e.getBoundingClientRect();
        if(r.width<2||r.height<2||r.bottom<-h*0.2||r.top>h*1.6)return;
        var st=getComputedStyle(e); if(st.visibility==='hidden'||st.display==='none')return;
        var label=(e.getAttribute('aria-label')||e.innerText||e.value||e.placeholder||e.title||'').replace(/\\s+/g,' ').trim();
        if(!label){var img=e.querySelector&&e.querySelector('img[alt]'); if(img)label=img.alt;}
        if(!label&&e.tagName!=='INPUT'&&e.tagName!=='TEXTAREA'&&e.tagName!=='SELECT')return;
        e.setAttribute('data-grove',n); window.__grove[n]=e;
        var it={n:n,tag:e.tagName.toLowerCase(),label:label.slice(0,70)};
        if(e.type)it.type=e.type; if(e.autocomplete)it.auto=e.autocomplete;
        if((e.tagName==='INPUT'||e.tagName==='TEXTAREA')&&e.type!=='password')it.value=(e.value||'').slice(0,60);
        var state=e.getAttribute('data-state')||e.getAttribute('aria-pressed')||e.getAttribute('aria-checked')||e.getAttribute('aria-selected')||'';
        if(state&&state!=='false')it.state=state;
        out.push(it); n++;
      });
      var board=[];
      all('[data-state],[evaluation],[aria-roledescription],[role=gridcell],[role=img][aria-label]').forEach(function(e){
        if(board.length>=90||e.hasAttribute('data-grove'))return;
        var r=e.getBoundingClientRect(); if(r.width<2||r.height<2)return;
        var l=(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50);
        var st=e.getAttribute('data-state')||e.getAttribute('evaluation')||'';
        if(l||st)board.push(l+(st&&l.toLowerCase().indexOf(st)<0?' {'+st+'}':''));
      });
      var text=(document.body?deepText(document.body):'').replace(/[ \\t]+/g,' ').replace(/\\n\\s*\\n+/g,'\\n').slice(0,2600);
      return JSON.stringify({url:location.href,title:document.title,items:out,board:board.join('\\n'),text:text});
    })()
    """
    let raw = await js(code)
    guard let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      var page = Page(url: await url())
      page.error = raw == "error" ? lastError : "unreadable"
      return page
    }
    return Page(url: obj["url"] as? String ?? "", title: obj["title"] as? String ?? "",
                items: obj["items"] as? [[String: Any]] ?? [], text: obj["text"] as? String ?? "",
                board: obj["board"] as? String ?? "")
  }

  static func clickJS(_ n: Int) -> String {
    "(function(){var e=(window.__grove&&window.__grove[\(n)])||document.querySelector('[data-grove=\"\(n)\"]'); if(!e)return 'not found'; e.scrollIntoView({block:'center'}); e.click(); return 'ok';})()"
  }

  static func typeJS(_ n: Int, _ text: String) -> String {
    let t = (try? String(data: JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)) ?? "[\"\"]"
    return """
    (function(){var e=(window.__grove&&window.__grove[\(n)])||document.querySelector('[data-grove="\(n)"]'); if(!e)return 'not found'; var t=\(t)[0];
    e.scrollIntoView({block:'center'}); e.focus();
    if(e.isContentEditable){document.execCommand('selectAll');document.execCommand('insertText',false,t);return 'ok';}
    var proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(e,t);
    e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';})()
    """
  }

  static func selectJS(_ n: Int, _ text: String) -> String {
    let t = (try? String(data: JSONSerialization.data(withJSONObject: [text.lowercased()]), encoding: .utf8)) ?? "[\"\"]"
    return """
    (function(){var e=(window.__grove&&window.__grove[\(n)])||document.querySelector('[data-grove="\(n)"]'); if(!e||!e.options)return 'not a list'; var t=\(t)[0];
    for(var i=0;i<e.options.length;i++){if(e.options[i].text.toLowerCase().indexOf(t)>=0){e.selectedIndex=i;e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';}}
    return 'no such option';})()
    """
  }
}
