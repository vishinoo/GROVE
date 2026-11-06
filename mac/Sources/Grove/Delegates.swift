/*
  Handing a job to another AI, in their own browser, under their own sign-ins.

  Grove is one model with a phone, a calendar and a pair of hands. It is not
  the best thing to ask for a thousand lines of code, a long piece of
  research, or an image — and pretending otherwise produces the worst answer
  in the app: a confident paragraph from a lite model where somebody wanted
  the real thing. Their Chrome is already signed in to the sites that *are*
  good at those, and they are paying for them.

  So "ask Claude to write the migration" is a job like any other job here —
  open the site, type into the box, press Return — and the browser agent can
  already do every one of those steps. Three things made it do them badly,
  and this file is those three things:

  - **It answered instead of asking.** A model handed a question answers it;
    that is what a model is for. Nothing in the decision said that naming
    another assistant is an instruction about *where the work happens*, so
    "ask ChatGPT what the best approach is" came back as Grove's own opinion,
    which is the one reply that is certainly not what was asked for.
  - **It called it done once the prompt was typed.** The mover judges its own
    work and is generous about it (the same fault as five moves of 2048 called
    playing it). A prompt sitting in a composer looks exactly like a finished
    job if nobody says otherwise, so the answer — the entire point — was never
    waited for and never read back.
  - **It paid a model call for every two seconds of somebody else's thinking.**
    A long answer takes a minute or more, and the loop wakes up, reads the
    page and calls the model on every step of it. Thirty calls to watch text
    appear. Exactly the chess problem, and it gets the chess answer: waiting
    is watched for, not thought about (`Browser.awaitWritten`).

  What this is not: a second brain. Nothing here decides anything. The
  delegate is a destination and a page full of instructions about that
  destination, handed to the same mover, with the same confirmations in front
  of anything irreversible.
*/

import Foundation

enum Delegates {
  struct Delegate {
    let id: String
    /** What to call it out loud. */
    let name: String
    /** Where it lives. Empty when it is an app on this Mac rather than a site. */
    let url: String
    /** An app on this Mac, driven by sight. Empty for a website. */
    let app: String

    /** What the words people actually use for it, lowercased. */
    let said: [String]
    /** What it is for, one line, so the model can pick between them. */
    let good: String
    /**
      A command to run in Terminal instead, with {task} where the request goes.

      For the ones that are a program rather than a page. Driving Claude Code
      by taking pictures of VS Code and clicking at where its panel looked
      like it was is how "type this into Claude" ended up typing it into the
      editor — measured: app, click, type, click, click, and the run's own
      parting lesson was "use keyboard shortcuts rather than guessing icon
      locations". A CLI has an exact way in, so it gets one.
    */
    var command: String = ""
  }

  /**
    The ones worth naming.

    Deliberately short and deliberately not a plugin system. Each entry is a
    claim that this app knows how to hand a job over there and get something
    back, and that claim is only worth making where it has been looked at.
    A site nobody listed is still reachable — they can say "on perplexity"
    and the ordinary agent goes there — it just does not get the waiting and
    the read-back, which are the parts that need to know what they are
    looking at.
  */
  static let all: [Delegate] = [
    Delegate(id: "claude", name: "Claude", url: "https://claude.ai/new", app: "",
             said: ["claude", "claude ai", "claude.ai", "anthropic"],
             good: "writing, code, long documents, reading something carefully"),
    Delegate(id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", app: "",
             said: ["chatgpt", "chat gpt", "gpt", "openai", "open ai"],
             good: "general questions, drafts, images"),
    Delegate(id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", app: "",
             said: ["gemini", "bard", "google ai"],
             good: "anything touching their Google account, long documents"),
    Delegate(id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/", app: "",
             said: ["perplexity"],
             good: "research with sources"),
    Delegate(id: "grok", name: "Grok", url: "https://grok.com/", app: "",
             said: ["grok"],
             good: "what people are saying right now"),
    Delegate(id: "copilot", name: "GitHub Copilot", url: "https://github.com/copilot", app: "",
             said: ["copilot", "github copilot"],
             good: "questions about a repository"),
    Delegate(id: "claude-code", name: "Claude Code", url: "", app: "",
             said: ["claude code", "claudecode", "claude cli", "codex"],
             good: "real work in a codebase on this Mac — reading it, changing it, running it",
             command: "claude {task}"),
    Delegate(id: "vscode", name: "VS Code", url: "", app: "Visual Studio Code",
             said: ["vs code", "vscode", "visual studio code", "my editor"],
             good: "looking at a file that is already open"),
    Delegate(id: "cursor", name: "Cursor", url: "", app: "Cursor",
             said: ["cursor"],
             good: "work in a codebase on this Mac"),
    Delegate(id: "higgsfield", name: "Higgsfield", url: "https://higgsfield.ai/", app: "",
             said: ["higgsfield", "higgs field"],
             good: "video, and moving a still image"),
    Delegate(id: "suno", name: "Suno", url: "https://suno.com/create", app: "",
             said: ["suno"],
             good: "music, written and sung"),
  ]

  /**
    The one they named, if they named one.

    Matched on word boundaries, never on containment: "gpt" inside "gpt-4" is
    the same destination, but a bare substring search makes "grok" out of
    "grokking" and sends a perfectly ordinary sentence to another website.
    The sentence has to *name* it.
  */
  static func named(_ said: String) -> Delegate? {
    let hay = " " + said.lowercased().replacingOccurrences(of: #"[^a-z0-9. ]+"#, with: " ", options: .regularExpression) + " "
    // Longest phrase first, so "chat gpt" is not answered by "gpt" and
    // "claude code" reaches the editor rather than the website.
    let byLength = all.flatMap { d in d.said.map { (phrase: $0, delegate: d) } }.sorted { $0.phrase.count > $1.phrase.count }
    for one in byLength where hay.contains(" \(one.phrase) ") { return one.delegate }
    return nil
  }

  /**
    Whether the sentence is asking for the work to happen somewhere else at
    all, rather than merely mentioning one of them.

    "What do you think of Claude" names Claude and delegates nothing; "ask
    Claude what it thinks" is the same words rearranged into an instruction.
    The difference is a verb of handing over, **immediately in front of the
    name**, and the adjacency is the whole rule rather than a refinement of
    it: looking for the verb anywhere in the sentence turns "use the cursor
    keys to move" into a hand-off to an editor, because it contains "use"
    and it contains "cursor".

    The cost of being wrong is asymmetric and that is what sets the strictness.
    A missed delegation runs as an ordinary browser task, which is what
    happened before this file existed. A false one opens claude.ai in the
    middle of somebody's actual job.
  */
  static let verbs = #"(ask|get|have|tell|send (this|that|it) to|put (this|that|it) (in|into|through)|pass (this|that|it) to|delegate (this|that|it)? ?to|hand (this|that|it)? ?(off|over)? to|run (this|that|it) (by|through)|use|on|with|through|via|in)"#

  static func wanted(in said: String) -> Delegate? {
    let hay = " " + said.lowercased().replacingOccurrences(of: #"[^a-z0-9. ]+"#, with: " ", options: .regularExpression) + " "
    let byLength = all.flatMap { d in d.said.map { (phrase: $0, delegate: d) } }.sorted { $0.phrase.count > $1.phrase.count }
    for one in byLength {
      let name = NSRegularExpression.escapedPattern(for: one.phrase)
      if hay.range(of: #"\b\#(verbs)\s+\#(name)\b"#, options: [.regularExpression]) != nil { return one.delegate }
    }
    return nil
  }

  /**
    What to actually give the other AI, dug out of the goal Grove wrote.

    The goal reads "Ask Claude to write a cover letter for Jane Street", and
    pasting that whole sentence into Claude is asking Claude to ask Claude.
    So the hand-off itself comes off the front and what is left is the
    request, in their words.

    Failing to find the seam is harmless and that is the point of doing it
    this way round: the whole goal goes over instead, which reads a little
    oddly to the other model and still asks it for the right thing. A
    cleverer rewrite that can be wrong is a worse trade than a clumsy one
    that cannot.
  */
  static func asked(from goal: String, to delegate: Delegate) -> String {
    let names = delegate.said.sorted { $0.count > $1.count }
      .map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|")
    let seam = #"(?i)^\s*(please\s+)?(ask|get|have|tell|send (this|that|it) to|pass (this|that|it) to|delegate (this|that|it)? ?to|hand (this|that|it)? ?(off|over)? to|run (this|that|it) (by|through)|use)\s+(\#(names))\b\s*(to|and|for me to|:)?\s*"#
    let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let r = trimmed.range(of: seam, options: .regularExpression) else { return trimmed }
    let rest = String(trimmed[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    // Nothing left but the hand-off ("ask Claude") is not a request anybody
    // could answer, so the original goes instead.
    return rest.count < 4 ? trimmed : rest
  }

  /**
    A shell command with the request in it, safe to put in an AppleScript
    string that goes to Terminal.

    Two layers, because there are two parsers between here and the program:
    the request is wrapped in shell single quotes with any single quote
    closed and reopened (the only escape single quotes have), and the result
    is then escaped for AppleScript's own string. Skipping either one means a
    sentence with an apostrophe in it — *"draft Priya's email"* — either
    fails to run or runs as something nobody wrote.
  */
  static func shell(_ template: String, task: String) -> String {
    let quoted = "'" + task.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return template.replacingOccurrences(of: "{task}", with: quoted)
  }

  static func applescript(_ command: String) -> String {
    command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  }

  /**
    What the mover needs to know, put at the top of the task's history so it
    rides with every move.

    Written as facts about the destination rather than as a procedure,
    because a procedure goes stale the first time a site moves its button and
    the model is better than a script at finding a box on a page it can see.
    What it cannot work out by looking is the part that is here: that the
    answer takes a while, that waiting is free and clicking is not, and that
    the job is not finished until there is something to bring back.
  */
  static func note(for delegate: Delegate, task: String) -> String {
    let where_ = delegate.app.isEmpty
      ? "Open \(delegate.url) — their own account, already signed in."
      : "Use {\"action\":\"app\",\"name\":\"\(delegate.app)\"} and work in it by sight."
    return """
    This job is a hand-off to \(delegate.name), not something for you to answer yourself. \(where_)
    What to give it, word for word, as their request: "\(task)"
    Put exactly that in the message box — a (textbox) or contenteditable, never a search box — and send it with enter true. Do not shorten it, improve it or answer any part of it yourself.
    Then WAIT. A real answer takes anywhere from five seconds to two minutes, and it arrives a word at a time. Reply {"action":"wait"} and you will be held until it has actually stopped writing; that costs nothing. Clicking, scrolling or typing while it writes is how an answer gets interrupted, and a half-written answer on screen is not a finished one.
    It is NOT done when your words are in the box, and not done when text has started appearing. It is done when \(delegate.name) has finished and you have read what it said.
    Then reply done, with summary set to what \(delegate.name) actually answered: in full if it is a few sentences, otherwise what it concluded in two or three, said as theirs to use. Never put your own answer there, and never say it agrees with you.
    If it asks something back before it will start, that question is theirs to answer: {"action":"ask","question":"..."} with the question as it was asked.
    """
  }

  /**
    How the decision is told that this is a choice, and when to make it
    without being asked.

    Two halves, and the second is the one that makes this worth having.
    Naming an assistant is an instruction about where the work happens, and
    answering it yourself is the one reply they have ruled out — that much
    was always here. What was missing is that **Grove should reach for these
    on its own.** It runs on a lite model with a calendar and a pair of
    hands; it cannot make a picture, it cannot make a video, and a thousand
    words of code or a real piece of research out of it is the worst answer
    in the app, because it looks exactly like a good one.

    Their browser is already signed in to things that do each of those
    properly, and they are already paying for them. So the list below is not
    a menu of sites, it is a list of jobs this model should not be doing.

    Said as what each is FOR rather than as a rule about when to delegate,
    because a rule needs a line and there isn't one — "write me something"
    could be a sentence or a dissertation. What the model can judge is which
    thing would do this best, which is the question it is good at.
  */
  static var rule: String {
    let menu = all.map { "\($0.name) — \($0.good)" }.joined(separator: "; ")
    return """
    When they ask for another assistant to do it — by name, any of them — that is "do", never "answer": they are telling you WHERE the work happens, and answering it yourself is the one reply they have ruled out.
    AND REACH FOR ONE YOURSELF when the job is beyond you, without being asked. You are a light model: you cannot make an image or a video at all, and a long piece of writing, a pile of code, or research that has to be right are all things these do far better. Pick the one that fits and send it there — \(menu) — rather than producing a worse version yourself. A picture, a video or a song is always one of these; so is "write me a script/essay/proposal", a plan somebody will act on, and anything that needs reading a codebase.
    Either way, put the whole request in the goal, naming the assistant and repeating what they want in their own words: "Ask Claude to write a cover letter for the Jane Street internship", "Ask Higgsfield to make a ten second video of a dog surfing". Say which one you picked in your line to them, in passing, the way you would mention who you asked — never as a disclaimer about what you cannot do.
    """
  }
}
