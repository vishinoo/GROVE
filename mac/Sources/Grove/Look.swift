/*
  What Grove looks like here, which is whatever it looks like on the phone.

  The phone sends its colour, name and manner whenever they change (Link.swift)
  and this keeps the last of each, so the Mac opens in the right colours even
  before the phone has connected. Tide until told otherwise — the same default
  as the phone.
*/

import Foundation

struct LookUpdate {
  var colour: String?
  var label: String?
  var stops: [String]?
  var speed: Double?
  var warp: Double?
  var name: String?
  var manner: String?
  var about: String?
}

final class Look {
  var colour = "tide"
  var colourLabel = "Tide"
  var stops = ["#061C26", "#1F7A8C", "#C9EDE6", "#E3B868"]
  var speed = 0.8
  var warp = 1.6
  var name = "Grove"
  var manner = ""
  /** What Grove remembers about them, from the phone; sealed on disk by Vault, sent only when it changes. */
  var about = ""

  static func load() -> Look {
    let look = Look()
    let d = UserDefaults.standard
    if let v = d.string(forKey: "grove.look.colour") { look.colour = v }
    if let v = d.string(forKey: "grove.look.label") { look.colourLabel = v }
    if let v = d.stringArray(forKey: "grove.look.stops"), v.count == 4 { look.stops = v }
    if d.object(forKey: "grove.look.speed") != nil { look.speed = d.double(forKey: "grove.look.speed") }
    if d.object(forKey: "grove.look.warp") != nil { look.warp = d.double(forKey: "grove.look.warp") }
    if let v = d.string(forKey: "grove.look.name") { look.name = v }
    if let v = d.string(forKey: "grove.look.manner") { look.manner = v }
    look.about = Vault.load()
    return look
  }

  func apply(_ u: LookUpdate) {
    if let v = u.colour { colour = v }
    if let v = u.label { colourLabel = v }
    if let v = u.stops, v.count == 4 { stops = v }
    if let v = u.speed { speed = v }
    if let v = u.warp { warp = v }
    if let v = u.name, !v.isEmpty { name = v }
    if let v = u.manner { manner = v }
    if let v = u.about, v != about { about = v; Vault.save(v) }
    let d = UserDefaults.standard
    d.set(colour, forKey: "grove.look.colour")
    d.set(colourLabel, forKey: "grove.look.label")
    d.set(stops, forKey: "grove.look.stops")
    d.set(speed, forKey: "grove.look.speed")
    d.set(warp, forKey: "grove.look.warp")
    d.set(name, forKey: "grove.look.name")
    d.set(manner, forKey: "grove.look.manner")
  }

  var json: [String: Any] {
    ["colour": colour, "label": colourLabel, "stops": stops, "speed": speed, "warp": warp, "name": name]
  }
}
