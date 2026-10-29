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
    init(id: String, goal: String) { self.id = id; self.goal = goal }
  }

  private var tasks: [String: Task] = [:]
  /** Shown in the notch as it goes. */
  var onStep: ((String, [String]) -> Void)?

  private static let budget: TimeInterval = 60
  private static let maxSteps = 40
  /** Labels that are the irreversible step, whatever the model calls them. */
  private static let finalWords = #"(?i)\b(place (your )?order|buy now|pay( now)?|complete (purchase|order|checkout)|confirm (order|purchase|payment|booking)|submit( order| application)?|send( now)?|book( now)?|reserve|delete|apply( now)?|checkout and pay|purchase)\b"#

  // MARK: entry points

  func start(goal: String) async -> AgentResult {
    tasks = tasks.filter { Date().timeIntervalSince($0.value.touched) < 600 }
    let task = Task(id: String(UUID().uuidString.prefix(8)).lowercased(), goal: goal)
    tasks[task.id] = task
    Log.say("agent: start \(task.id) \(goal)")
    return await loop(task)
  }

  /** Their answer to a question, or `approve` after a yes to a confirmation. */
  func resume(task id: String, answer: String, approve: Bool) async -> AgentResult {
    guard let task = tasks[id] else {
      return AgentResult(state: "failed", spoken: "I lost track of that one on your Mac. Ask me again?", task: id)
    }
    task.touched = Date()
    if approve, let pending = task.confirm {
      task.confirm = nil
      let page = await Browser.url()
      guard page == pending.url else {
        task.history.append("The page changed before the press; confirm again before pressing anything.")
        return await loop(task)
      }
      let result = await Browser.js(Browser.clickJS(pending.n))
      task.history.append("They said yes. Pressed: \(pending.summary) → \(result)")
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
    let started = Date()
    if let failure = await Browser.ready() { return AgentResult(state: "failed", spoken: failure, task: task.id) }

    while Date().timeIntervalSince(started) < Agent.budget {
      guard task.steps < Agent.maxSteps else {
        return AgentResult(state: "failed", spoken: "I went round in circles on your Mac and stopped. It's on the page I got to.", task: task.id)
      }
      task.steps += 1
      let page = await Browser.read()
      guard let move = await Agent.next(goal: task.goal, history: task.history, page: page) else {
        return AgentResult(state: "failed", spoken: "I couldn't work out the next step on your Mac.", task: task.id)
      }
      let action = (move["action"] as? String ?? "").lowercased()
      let n = (move["n"] as? Int) ?? Int("\(move["n"] ?? "")") ?? -1
      let text = move["text"] as? String ?? ""
      let label = Agent.label(of: n, in: page)
      Log.say("agent: \(task.id) \(action) \(n) \(text.prefix(60))")

      switch action {
      case "go":
        let url = move["url"] as? String ?? ""
        await Browser.go(url)
        task.history.append("Went to \(url)")
        step(task, "Opening \(URL(string: url)?.host ?? url)")
      case "click":
        if label.range(of: Agent.finalWords, options: .regularExpression) != nil {
          return askToConfirm(task, n: n, url: page.url, summary: (move["summary"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Press \(label)?")
        }
        let r = await Browser.js(Browser.clickJS(n))
        task.history.append("Clicked [\(n)] \(label) → \(r)")
        step(task, "Clicking \(label.prefix(40))")
        try? await _Concurrency.Task.sleep(nanoseconds: 1_500_000_000)
      case "type":
        if Agent.isSecret(n, in: page) {
          task.history.append("Refused to type into [\(n)]: password and card fields are theirs to fill.")
          continue
        }
        let r = await Browser.js(Browser.typeJS(n, text))
        if (move["enter"] as? Bool) == true { await Browser.pressReturn() }
        task.history.append("Typed \"\(text)\" into [\(n)] \(label) → \(r)")
        step(task, "Typing \(text.prefix(30))")
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
        return askToConfirm(task, n: n, url: page.url, summary: (move["summary"] as? String) ?? text)
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

  private func askToConfirm(_ task: Task, n: Int, url: String, summary: String) -> AgentResult {
    task.confirm = Pending(n: n, url: url, summary: summary)
    task.history.append("Stopped for their yes: \(summary)")
    return AgentResult(state: "confirm", spoken: summary, task: task.id)
  }

  private func step(_ task: Task, _ line: String) {
    let recent = task.history.suffix(3).map { String($0.prefix(60)) }
    DispatchQueue.main.async { self.onStep?(task.goal, recent + [line]) }
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
  Each turn you see the goal, what has happened so far, and the current page: its address, numbered things you can press or type into, and some of its text.
  Reply with ONE next move as JSON:
  {"action":"go","url":"https://..."} — open an address. Go straight to search addresses when you can: https://www.youtube.com/results?search_query=..., https://www.google.com/search?q=..., https://www.amazon.com/s?k=..., https://www.linkedin.com/jobs/search/?keywords=..., https://www.indeed.com/jobs?q=...
  {"action":"click","n":12,"summary":"..."}
  {"action":"type","n":4,"text":"...","enter":true}
  {"action":"select","n":7,"text":"option"}
  {"action":"scroll"} {"action":"back"} {"action":"wait"}
  {"action":"ask","question":"..."} — when you need something only they know, or a choice that is theirs: which store, which size, which of these. One short spoken question.
  {"action":"confirm","n":31,"summary":"..."} — before anything that buys, sends, submits, books, applies or deletes. The summary is read aloud and they answer yes or no: say exactly what will happen, with the item, the price and total if shown, and where it goes, e.g. "Placing the order: one whole watermelon, $5.49, total $9.12, to 12 King Street. Go ahead?"
  {"action":"done","summary":"..."} — the goal is reached. One or two spoken sentences on what is now on their screen, e.g. "It's playing: Peter Thiel on Competition, on YouTube."
  {"action":"fail","summary":"..."} — it cannot be done; say why plainly.
  Rules:
  - Orders: before checkout, ask them to confirm the delivery address and the item you picked if either was not stated. Never change payment details. Never press the final button with click; use confirm.
  - Never type into password or card fields. If a sign-in is needed, ask them to sign in on the Mac and say when they have.
  - Prefer the obvious choice over asking, for things that cost nothing: the first good video, the top results.
  - For looking things up (jobs, reviews, prices), finish on the page that shows them and summarise the best two or three in done.
  - Do not repeat a move that just failed; try another way.
  JSON only.
  """

  private static func next(goal: String, history: [String], page: Browser.Page) async -> [String: Any]? {
    let info = Bundle.main.infoDictionary ?? [:]
    guard let key = info["GroveGeminiKey"] as? String, !key.isEmpty else { return nil }
    let model = (info["GroveModel"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "gemini-flash-lite-latest"
    guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent") else { return nil }

    let items = page.items.map { item -> String in
      var s = "[\(item["n"] ?? "")] \(item["tag"] ?? "")"
      if let t = item["type"] as? String, !t.isEmpty { s += "(\(t))" }
      s += " \(item["label"] ?? "")"
      if let v = item["value"] as? String, !v.isEmpty { s += " = \"\(v)\"" }
      return s
    }.joined(separator: "\n")
    let prompt = """
    Goal: \(goal)

    So far:
    \(history.isEmpty ? "(nothing yet)" : history.suffix(14).joined(separator: "\n"))

    Page: \(page.title)
    Address: \(page.url)
    Things on it:
    \(items.isEmpty ? "(none)" : items)

    Text:
    \(page.text)
    """

    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
    let body: [String: Any] = [
      "systemInstruction": ["parts": [["text": brief]]],
      "contents": [["role": "user", "parts": [["text": prompt]]]],
      "generationConfig": ["responseMimeType": "application/json", "maxOutputTokens": 400, "temperature": 0.2],
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    for _ in 0..<2 {
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
    let (ok, out) = await run("tell application \"Google Chrome\" to execute active tab of front window javascript \"'ok'\"")
    if ok && out == "ok" { return nil }
    if out.lowercased().contains("javascript") {
      return "One thing first, in Chrome on your Mac: View, Developer, then tick Allow JavaScript from Apple Events. Then ask me again."
    }
    return "I couldn't control Chrome. Allow Grove under Automation in System Settings, from the Grove menu's checklist."
  }

  static func go(_ url: String) async {
    var s = url.trimmingCharacters(in: .whitespaces)
    if !s.contains("://") { s = "https://" + s }
    _ = await run("tell application \"Google Chrome\" to set URL of active tab of front window to \(quoted(s))")
    for _ in 0..<20 {
      try? await _Concurrency.Task.sleep(nanoseconds: 400_000_000)
      let (_, loading) = await run("tell application \"Google Chrome\" to get loading of active tab of front window")
      if loading == "false" { break }
    }
    try? await _Concurrency.Task.sleep(nanoseconds: 800_000_000)
  }

  static func url() async -> String {
    await run("tell application \"Google Chrome\" to get URL of active tab of front window").1
  }

  static func js(_ code: String) async -> String {
    let (ok, out) = await run("tell application \"Google Chrome\" to execute active tab of front window javascript \(quoted(code))")
    return ok ? out : "error"
  }

  static func pressReturn() async {
    _ = await run("tell application \"System Events\" to key code 36")
    try? await _Concurrency.Task.sleep(nanoseconds: 1_500_000_000)
  }

  /** Numbers what can be pressed or typed into, and returns it with the page's text. */
  static func read() async -> Page {
    let code = """
    (function(){
      var sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick]';
      document.querySelectorAll('[data-grove]').forEach(function(e){e.removeAttribute('data-grove');});
      var out=[],n=0,h=innerHeight;
      document.querySelectorAll(sel).forEach(function(e){
        if(n>=140)return;
        var r=e.getBoundingClientRect();
        if(r.width<2||r.height<2||r.bottom<-h*0.2||r.top>h*1.6)return;
        var st=getComputedStyle(e); if(st.visibility==='hidden'||st.display==='none')return;
        var label=(e.getAttribute('aria-label')||e.innerText||e.value||e.placeholder||e.title||'').replace(/\\s+/g,' ').trim();
        if(!label){var img=e.querySelector&&e.querySelector('img[alt]'); if(img)label=img.alt;}
        if(!label&&e.tagName!=='INPUT'&&e.tagName!=='TEXTAREA'&&e.tagName!=='SELECT')return;
        e.setAttribute('data-grove',n);
        var it={n:n,tag:e.tagName.toLowerCase(),label:label.slice(0,90)};
        if(e.type)it.type=e.type; if(e.autocomplete)it.auto=e.autocomplete;
        if((e.tagName==='INPUT'||e.tagName==='TEXTAREA')&&e.type!=='password')it.value=(e.value||'').slice(0,60);
        out.push(it); n++;
      });
      var text=(document.body?document.body.innerText:'').replace(/\\n\\s*\\n+/g,'\\n').slice(0,2600);
      return JSON.stringify({url:location.href,title:document.title,items:out,text:text});
    })()
    """
    let raw = await js(code)
    guard let data = raw.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return Page(url: await url()) }
    return Page(url: obj["url"] as? String ?? "", title: obj["title"] as? String ?? "",
                items: obj["items"] as? [[String: Any]] ?? [], text: obj["text"] as? String ?? "")
  }

  static func clickJS(_ n: Int) -> String {
    "(function(){var e=document.querySelector('[data-grove=\"\(n)\"]'); if(!e)return 'not found'; e.scrollIntoView({block:'center'}); e.click(); return 'ok';})()"
  }

  static func typeJS(_ n: Int, _ text: String) -> String {
    let t = (try? String(data: JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)) ?? "[\"\"]"
    return """
    (function(){var e=document.querySelector('[data-grove="\(n)"]'); if(!e)return 'not found'; var t=\(t)[0];
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
    (function(){var e=document.querySelector('[data-grove="\(n)"]'); if(!e||!e.options)return 'not a list'; var t=\(t)[0];
    for(var i=0;i<e.options.length;i++){if(e.options[i].text.toLowerCase().indexOf(t)>=0){e.selectedIndex=i;e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';}}
    return 'no such option';})()
    """
  }
}
