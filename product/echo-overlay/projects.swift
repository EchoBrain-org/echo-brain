import AppKit
import Foundation

// Projects: the window a person lives in. The list is every project they are a
// member of, a project opens to what has been added to it, and the bar at the
// bottom writes into a project or asks ECHO. Everything else — writing, making
// a project, managing who is in one — sits in a sidebar that stays shut.
//
// Project screens await server contracts. The live home uses UploadSession
// and the existing Ask/record clients; unavailable project actions stay disabled.

enum ProjectAudience: String, CaseIterable {
    case onlyMe = "only_me"
    case project
    case everyone = "team"

    func label(project: String) -> String {
        switch self {
        case .onlyMe: return "Only me"
        case .project: return project
        case .everyone: return "Everyone in my organization"
        }
    }

    func consequence(project: String) -> String {
        switch self {
        case .onlyMe: return "Only you can see it."
        case .project: return "Everyone in \(project) can see it."
        case .everyone: return "Everyone in my organization can see it."
        }
    }
}

struct ProjectSummary {
    let id: String
    var name: String
    var initial: String
    let tint: NSColor
    var unread: Int
    var when: String
    var preview: String
}

struct ProjectEntry {
    let kind: String
    let title: String
    let body: String
    let when: String
    let isDecision: Bool
}

struct ProjectMember {
    let id: String
    let name: String
    let initials: String
    let tint: NSColor
}

@MainActor
final class ProjectsStore {
    static let shared = ProjectsStore()

    private(set) var projects: [ProjectSummary]
    private var entries: [String: [ProjectEntry]]
    private var roster: [String: [String]]
    private var leads: [String: String]
    private var lastWrite: String?

    /// Everyone at the organization. The real directory read returns display
    /// names and opaque ids, never email addresses.
    let directory: [ProjectMember] = []
    let me = ""
    private init() {
        projects = []; entries = [:]; roster = [:]; leads = [:]
    }

    func name(of id: String) -> String {
        projects.first { $0.id == id }?.name ?? id
    }

    func entries(of id: String) -> [ProjectEntry] {
        entries[id] ?? []
    }

    func members(of id: String) -> [ProjectMember] {
        let ids = roster[id] ?? []
        return ids.compactMap { memberID in directory.first { $0.id == memberID } }
    }

    func lead(of id: String) -> String? {
        leads[id]
    }

    func isLead(_ memberID: String, of id: String) -> Bool {
        leads[id] == memberID
    }

    /// Anyone not already in the project, for the add field.
    func candidates(for id: String) -> [ProjectMember] {
        let ids = Set(roster[id] ?? [])
        return directory.filter { !ids.contains($0.id) }
    }

    func markRead(_ id: String) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        projects[index].unread = 0
    }

    func addMember(_ memberID: String, to id: String) {
        guard roster[id] != nil, !(roster[id] ?? []).contains(memberID) else { return }
        roster[id]?.append(memberID)
    }

    /// A lead cannot be removed; leadership moves first. That keeps a project
    /// from ending up with nobody who can manage it.
    func removeMember(_ memberID: String, from id: String) {
        guard leads[id] != memberID else { return }
        roster[id]?.removeAll { $0 == memberID }
    }

    /// Leadership only ever moves to someone already in the project, so a
    /// handover can never widen who can read it.
    func makeLead(_ memberID: String, of id: String) {
        guard (roster[id] ?? []).contains(memberID) else { return }
        leads[id] = memberID
    }

    @discardableResult
    func createProject(name: String, members: [String], lead: String, files: [String]) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = "p\(UUID().uuidString.prefix(8).lowercased())"
        let tints = directory.map(\.tint)
        let summary = ProjectSummary(
            id: id, name: trimmed,
            initial: String(trimmed.prefix(1)).uppercased(),
            tint: tints[abs(id.hashValue) % max(tints.count, 1)],
            unread: 0, when: "now",
            preview: files.isEmpty ? "You made this project" : "You added \(files.count) file\(files.count == 1 ? "" : "s")"
        )
        projects.insert(summary, at: 0)
        var people = members
        if !people.contains(lead) { people.append(lead) }
        roster[id] = people
        leads[id] = lead
        entries[id] = files.map { file in
            ProjectEntry(
                kind: "FILE", title: file,
                body: "You added a file when you created the project.",
                when: "Just now", isDecision: false
            )
        }
        return id
    }

    /// The write path. Audience is recorded on the entry; it never decides who
    /// a later reader is, which the server will enforce for real.
    func write(title: String, body: String, to id: String, audience: ProjectAudience) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        let kind = audience == .onlyMe ? "NOTE · ONLY ME" : "NOTE"
        let entry = ProjectEntry(kind: kind, title: title, body: body, when: "Just now", isDecision: false)
        entries[id, default: []].insert(entry, at: 0)
        projects[index].when = "now"
        projects[index].preview = "You: \(title)"
        lastWrite = id
    }

    var undoAvailable: Bool { lastWrite != nil }

    /// Undo removes the entry this session just added, nothing else.
    @discardableResult
    func undoLastWrite() -> String? {
        guard let id = lastWrite, var list = entries[id], !list.isEmpty else { return nil }
        list.removeFirst()
        entries[id] = list
        if let index = projects.firstIndex(where: { $0.id == id }) {
            projects[index].preview = list.first?.title ?? "Nothing yet"
        }
        lastWrite = nil
        return id
    }
}

// MARK: - Drawn pieces

/// A circle with initials, and for a project the count of what arrived since
/// the last visit.
final class ProjectAvatarView: NSView {
    var initial = "" { didSet { needsDisplay = true } }
    var tint = NSColor.darkGray { didSet { needsDisplay = true } }
    var unread = 0 { didSet { needsDisplay = true } }
    var diameter: CGFloat = 46 {
        didSet {
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }

    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize {
        NSSize(width: diameter + (unread > 0 ? 12 : 0), height: diameter + 6)
    }

    override func draw(_ dirtyRect: NSRect) {
        let circle = NSRect(x: 0, y: 3, width: diameter, height: diameter)
        tint.setFill()
        NSBezierPath(ovalIn: circle).fill()

        let initialAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: diameter >= 40 ? 16 : 11, weight: .semibold),
            .foregroundColor: EchoTheme.text,
        ]
        let initialSize = (initial as NSString).size(withAttributes: initialAttributes)
        (initial as NSString).draw(
            at: NSPoint(x: circle.midX - initialSize.width / 2, y: circle.midY - initialSize.height / 2),
            withAttributes: initialAttributes
        )

        guard unread > 0 else { return }
        let label = String(unread)
        let badgeAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .bold),
            .foregroundColor: EchoTheme.inkDeep,
        ]
        let labelSize = (label as NSString).size(withAttributes: badgeAttributes)
        let badgeWidth = max(20, ceil(labelSize.width) + 12)
        let badge = NSRect(x: circle.maxX - 12, y: 0, width: badgeWidth, height: 20)

        EchoTheme.ink.setFill()
        NSBezierPath(roundedRect: badge.insetBy(dx: -2, dy: -2), xRadius: 12, yRadius: 12).fill()
        EchoTheme.gold.setFill()
        NSBezierPath(roundedRect: badge, xRadius: 10, yRadius: 10).fill()
        (label as NSString).draw(
            at: NSPoint(x: badge.midX - labelSize.width / 2, y: badge.midY - labelSize.height / 2),
            withAttributes: badgeAttributes
        )
    }
}

/// One row of the project list: circle, name, the latest line, and when.
final class ProjectRowView: NSView {
    private let avatar = ProjectAvatarView()
    private let nameField = NSTextField(labelWithString: "")
    private let previewField = NSTextField(labelWithString: "")
    private let timeField = NSTextField(labelWithString: "")
    private let rule = NSView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private func build() {
        for field in [nameField, previewField, timeField] {
            field.lineBreakMode = .byTruncatingTail
            field.translatesAutoresizingMaskIntoConstraints = false
            addSubview(field)
        }
        avatar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(avatar)
        rule.wantsLayer = true
        rule.layer?.backgroundColor = EchoTheme.quietBorder.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rule)

        previewField.font = .systemFont(ofSize: 13.5)
        timeField.font = .systemFont(ofSize: 12)
        timeField.textColor = EchoTheme.faintText
        timeField.setContentHuggingPriority(.required, for: .horizontal)
        timeField.setContentCompressionResistancePriority(.required, for: .horizontal)

        NSLayoutConstraint.activate([
            avatar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            avatar.centerYAnchor.constraint(equalTo: centerYAnchor),
            avatar.widthAnchor.constraint(equalToConstant: 58),
            avatar.heightAnchor.constraint(equalToConstant: 52),

            nameField.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 8),
            nameField.topAnchor.constraint(equalTo: topAnchor, constant: 15),
            timeField.leadingAnchor.constraint(greaterThanOrEqualTo: nameField.trailingAnchor, constant: 10),
            timeField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            timeField.firstBaselineAnchor.constraint(equalTo: nameField.firstBaselineAnchor),

            previewField.leadingAnchor.constraint(equalTo: nameField.leadingAnchor),
            previewField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            previewField.topAnchor.constraint(equalTo: nameField.bottomAnchor, constant: 3),

            rule.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            rule.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            rule.bottomAnchor.constraint(equalTo: bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    func configure(with project: ProjectSummary) {
        avatar.initial = project.initial
        avatar.tint = project.tint
        avatar.unread = project.unread
        nameField.stringValue = project.name
        previewField.stringValue = project.preview
        timeField.stringValue = project.when
        let unseen = project.unread > 0
        nameField.font = .systemFont(ofSize: 15, weight: unseen ? .semibold : .medium)
        nameField.textColor = EchoTheme.text
        previewField.textColor = unseen ? EchoTheme.text : EchoTheme.faintText
        toolTip = project.preview
    }
}

/// One thing that arrived in a project, drawn like a notification.
final class ProjectEntryView: NSView {
    private let tile = NSView()
    private let kindField = NSTextField(labelWithString: "")
    private let timeField = NSTextField(labelWithString: "")
    private let titleField = NSTextField(labelWithString: "")
    private let bodyField = NSTextField(wrappingLabelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.text.withAlphaComponent(0.08).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 16, yRadius: 16).fill()
    }

    private func build() {
        wantsLayer = true
        tile.wantsLayer = true
        tile.layer?.cornerRadius = 8
        tile.translatesAutoresizingMaskIntoConstraints = false
        addSubview(tile)

        kindField.font = .systemFont(ofSize: 11, weight: .semibold)
        timeField.font = .systemFont(ofSize: 12)
        timeField.textColor = EchoTheme.faintText
        titleField.font = .systemFont(ofSize: 14.5, weight: .semibold)
        titleField.textColor = EchoTheme.text
        titleField.lineBreakMode = .byTruncatingTail
        bodyField.font = .systemFont(ofSize: 13.5)
        bodyField.textColor = EchoTheme.text.withAlphaComponent(0.8)
        bodyField.maximumNumberOfLines = 2
        bodyField.lineBreakMode = .byTruncatingTail

        for field in [kindField, timeField, titleField, bodyField] {
            field.translatesAutoresizingMaskIntoConstraints = false
            addSubview(field)
        }
        timeField.setContentHuggingPriority(.required, for: .horizontal)
        timeField.setContentCompressionResistancePriority(.required, for: .horizontal)

        NSLayoutConstraint.activate([
            tile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            tile.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            tile.widthAnchor.constraint(equalToConstant: 30),
            tile.heightAnchor.constraint(equalToConstant: 30),

            kindField.leadingAnchor.constraint(equalTo: tile.trailingAnchor, constant: 12),
            kindField.topAnchor.constraint(equalTo: topAnchor, constant: 13),
            timeField.leadingAnchor.constraint(greaterThanOrEqualTo: kindField.trailingAnchor, constant: 8),
            timeField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            timeField.firstBaselineAnchor.constraint(equalTo: kindField.firstBaselineAnchor),

            titleField.leadingAnchor.constraint(equalTo: kindField.leadingAnchor),
            titleField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            titleField.topAnchor.constraint(equalTo: kindField.bottomAnchor, constant: 3),

            bodyField.leadingAnchor.constraint(equalTo: kindField.leadingAnchor),
            bodyField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            bodyField.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 2),
            bodyField.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -13),
        ])
    }

    func configure(with entry: ProjectEntry) {
        kindField.stringValue = entry.kind
        kindField.textColor = entry.isDecision ? EchoTheme.goldBright : EchoTheme.faintText
        timeField.stringValue = entry.when
        titleField.stringValue = entry.title
        bodyField.stringValue = entry.body
        tile.layer?.backgroundColor = entry.isDecision
            ? EchoTheme.gold.cgColor
            : EchoTheme.text.withAlphaComponent(0.12).cgColor
    }
}

/// A selectable pill. Used for the audience choice, where the selected one has
/// to be unmistakable before anything is sent.
final class ChipButton: NSButton {
    var selected = false { didSet { needsDisplay = true } }
    var chipHeight: CGFloat = 30 { didSet { invalidateIntrinsicContentSize() } }

    private var chipFont: NSFont { .systemFont(ofSize: 13) }

    override var intrinsicContentSize: NSSize {
        let width = ceil((title as NSString).size(withAttributes: [.font: chipFont]).width)
        return NSSize(width: width + 28, height: chipHeight)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { path().fill() }

    override func draw(_ dirtyRect: NSRect) {
        let shape = path()
        if selected {
            EchoTheme.gold.withAlphaComponent(0.18).setFill()
            shape.fill()
            EchoTheme.gold.setStroke()
        } else {
            if isHighlighted {
                EchoTheme.text.withAlphaComponent(0.10).setFill()
                shape.fill()
            }
            EchoTheme.border.setStroke()
        }
        shape.lineWidth = 1
        shape.stroke()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: chipFont,
            .foregroundColor: selected ? EchoTheme.goldBright : EchoTheme.text,
            .paragraphStyle: paragraph,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            in: NSRect(x: 0, y: floor((bounds.height - size.height) / 2), width: bounds.width, height: ceil(size.height)),
            withAttributes: attributes
        )
    }

    private func path() -> NSBezierPath {
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        return NSBezierPath(roundedRect: inset, xRadius: inset.height / 2, yRadius: inset.height / 2)
    }
}

/// The "To Harbor relaunch ⌄" chip. A plain pill that pops a menu, so the
/// destination reads as a fact rather than a form control.
final class ChipMenuButton: NSButton {
    var choices: [String] = []
    var onChoose: ((Int) -> Void)?
    private var chipFont: NSFont { .systemFont(ofSize: 13.5) }

    override var intrinsicContentSize: NSSize {
        let width = ceil((title as NSString).size(withAttributes: [.font: chipFont]).width)
        return NSSize(width: width + 38, height: 28)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { path().fill() }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.text.withAlphaComponent(isHighlighted ? 0.18 : 0.12).setFill()
        path().fill()

        let attributes: [NSAttributedString.Key: Any] = [
            .font: chipFont,
            .foregroundColor: EchoTheme.text,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            at: NSPoint(x: 12, y: floor((bounds.height - size.height) / 2)),
            withAttributes: attributes
        )

        let chevron = NSBezierPath()
        let centre = NSPoint(x: bounds.maxX - 16, y: bounds.midY + 1)
        chevron.move(to: NSPoint(x: centre.x - 4, y: centre.y + 2))
        chevron.line(to: NSPoint(x: centre.x, y: centre.y - 2))
        chevron.line(to: NSPoint(x: centre.x + 4, y: centre.y + 2))
        chevron.lineWidth = 1.5
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        EchoTheme.mutedText.setStroke()
        chevron.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        let menu = NSMenu()
        for (index, choice) in choices.enumerated() {
            let item = NSMenuItem(title: choice, action: #selector(choose(_:)), keyEquivalent: "")
            item.target = self
            item.tag = index
            item.state = choice == title ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 4), in: self)
    }

    @objc private func choose(_ sender: NSMenuItem) {
        onChoose?(sender.tag)
    }

    private func path() -> NSBezierPath {
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    }
}

/// The rounded field at the bottom of the window.
final class BarBackgroundView: NSView {
    var highlighted = false { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        EchoTheme.surface.setFill()
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: inset, xRadius: inset.height / 2, yRadius: inset.height / 2)
        shape.fill()
        (highlighted ? EchoTheme.gold : EchoTheme.border).setStroke()
        shape.lineWidth = 1
        shape.stroke()
    }
}

/// The dashed box files are dropped into.
final class DropWellView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let inset = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shape = NSBezierPath(roundedRect: inset, xRadius: 10, yRadius: 10)
        shape.lineWidth = 1
        shape.setLineDash([4, 4], count: 2, phase: 0)
        EchoTheme.text.withAlphaComponent(0.24).setStroke()
        shape.stroke()
    }
}

/// A sidebar entry: icon, label, and nothing else.
final class SidebarRowButton: NSButton {
    private var labelFont: NSFont { .systemFont(ofSize: 13.5) }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 32)
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill() }

    override func draw(_ dirtyRect: NSRect) {
        if isHighlighted {
            EchoTheme.text.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        }
        var textLeading: CGFloat = 10
        if let image {
            let box = NSRect(x: 10, y: floor((bounds.height - 16) / 2), width: 16, height: 16)
            image.isTemplate = true
            EchoTheme.mutedText.set()
            image.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            textLeading = box.maxX + 10
        }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: EchoTheme.text,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        (title as NSString).draw(
            at: NSPoint(x: textLeading, y: floor((bounds.height - size.height) / 2)),
            withAttributes: attributes
        )
    }
}

private final class ProjectsWindow: NSWindow {
    // Accessory apps have no Edit menu to route field-editor shortcuts.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers == .command, let editor = firstResponder as? NSTextView {
            switch event.charactersIgnoringModifiers {
            case "a": editor.selectAll(nil)
            case "c": editor.copy(nil)
            case "x": editor.cut(nil)
            case "v": editor.paste(nil)
            case "z": editor.undoManager?.undo()
            default: return super.performKeyEquivalent(with: event)
            }
            return true
        }
        if modifiers == [.command, .shift], event.charactersIgnoringModifiers?.lowercased() == "z",
           let editor = firstResponder as? NSTextView {
            editor.undoManager?.redo(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

@MainActor
private func circleButton(symbol: String, label: String, filled: Bool,
                          target: AnyObject, action: Selector) -> NSButton {
    let button = NSButton()
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 17
    button.layer?.backgroundColor = filled
        ? EchoTheme.gold.cgColor
        : EchoTheme.text.withAlphaComponent(0.10).cgColor
    button.contentTintColor = filled ? EchoTheme.inkDeep : EchoTheme.text
    button.target = target
    button.action = action
    button.setAccessibilityLabel(label)
    button.translatesAutoresizingMaskIntoConstraints = false
    return button
}

// MARK: - Write sheet

/// Two steps and no more: what it is, then who can see it. The audience is
/// never guessed, and the text stays on screen while it is chosen.
@MainActor
final class ProjectWriteSheet: NSObject {
    private let sheet = ProjectsWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
        styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
    private let title = NSTextField()
    private let body = NSTextView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let audienceRow = NSStackView()
    private let consequence = NSTextField(wrappingLabelWithString: "")
    private let availability = NSTextField(wrappingLabelWithString: "Not live yet: project sharing, other attachment types, and undo after saving.")
    private let next = PillButton(title: "Continue", target: nil, action: nil)
    private let save = PillButton(title: "Save", target: nil, action: nil)
    private let check = PillButton(title: "Check status", target: nil, action: nil)
    private let retry = PillButton(title: "Retry same save", target: nil, action: nil)
    private let another = PillButton(title: "New note", target: nil, action: nil)
    private let back = NSButton(title: "Back", target: nil, action: nil)
    private let closeButton = NSButton(title: "Cancel", target: nil, action: nil)
    private let attach = NSButton(title: "Choose text file…", target: nil, action: nil)
    private var chips: [ChipButton] = []
    private var visibility = UploadVisibility.onlyMe
    private var confirming = false
    private var session: UploadSession?
    private var admittedIdentity: AccountIdentity?
    var isPresented: Bool { sheet.sheetParent != nil }

    override init() { super.init(); build() }
    func present(over parent: NSWindow, session: UploadSession) {
        guard !isPresented else { return }
        self.session = session; admittedIdentity = session.identity
        title.stringValue = ""; body.string = ""; visibility = .onlyMe; confirming = false
        refresh()
        parent.beginSheet(sheet)
        sheet.makeFirstResponder(body)
    }
    func refresh() {
        guard let session else { return }
        if admittedIdentity != session.identity {
            title.stringValue = ""; body.string = ""; confirming = false; visibility = .onlyMe
            admittedIdentity = session.identity
        }
        let compose = session.canCompose
        title.isEnabled = compose; body.isEditable = compose; attach.isEnabled = compose
        status.stringValue = session.status
        next.isHidden = confirming || !compose
        next.isEnabled = compose
        audienceRow.isHidden = !confirming || !compose
        consequence.isHidden = !confirming || !compose
        save.isHidden = !confirming || !compose
        save.isEnabled = compose
        back.isHidden = !confirming || !compose
        check.isHidden = session.recovery == nil || session.receipt != nil
        check.isEnabled = !session.busy
        retry.isHidden = session.draft == nil || session.receipt != nil
        retry.isEnabled = !session.busy
        another.isHidden = session.recovery == nil
        another.isEnabled = !session.busy
        closeButton.isEnabled = !session.hasOutstandingMutation
        closeButton.title = session.receipt == nil ? "Cancel" : "Done"
        for (index, chip) in chips.enumerated() {
            chip.selected = index == (visibility == .onlyMe ? 0 : 1)
        }
        consequence.stringValue = visibility == .onlyMe ? "Only you can read this note."
            : "Everyone currently in your organization can read this note."
    }
    func accountWillChange() {
        title.stringValue = ""; body.string = ""
        if session?.hasOutstandingMutation != true { sheet.sheetParent?.endSheet(sheet) }
        refresh()
    }
    @objc private func continueToAudience() {
        guard session?.canCompose == true else { return }
        if title.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Suggest a bounded title without modifying the original text.
            title.stringValue = suggestedTitle(body.string)
        }
        guard !body.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              body.string.utf8.count <= 8192, title.stringValue.utf8.count <= 200 else {
            status.stringValue = "Use nonempty text up to 8 KiB."; return
        }
        confirming = true; refresh()
    }
    private func suggestedTitle(_ source: String) -> String {
        var suggestion = source.split(whereSeparator: { $0.isNewline }).lazy.map {
            String($0).components(separatedBy: .controlCharacters).joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }.first(where: { !$0.isEmpty }) ?? "Note"
        while suggestion.utf8.count > 200 { suggestion.removeLast() }
        return suggestion.isEmpty ? "Note" : suggestion
    }
    @objc private func pickAudience(_ sender: ChipButton) {
        guard session?.canCompose == true else { return }
        visibility = sender.tag == 0 ? .onlyMe : .team; refresh()
    }
    @objc private func saveNote() {
        session?.submit(title: title.stringValue, text: body.string, visibility: visibility)
    }
    @objc private func checkSave() { session?.checkStatus() }
    @objc private func retrySave() { session?.retry() }
    @objc private func newNote() {
        guard let session, !session.busy else { return }
        if session.receipt == nil && session.recovery != nil {
            let alert = NSAlert(); alert.messageText = "Start another note?"
            alert.informativeText = "The previous save may have completed. Check its status or search first to avoid a duplicate."
            alert.addButton(withTitle: "Start another note"); alert.addButton(withTitle: "Keep previous save")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        session.startAnother(); title.stringValue = ""; body.string = ""; confirming = false; visibility = .onlyMe; refresh()
    }
    @objc private func goBack() { confirming = false; refresh() }
    @objc private func close() {
        guard session?.hasOutstandingMutation != true else { return }
        sheet.sheetParent?.endSheet(sheet)
    }
    @objc private func chooseFile() {
        guard session?.canCompose == true else { return }
        let picker = NSOpenPanel(); picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        picker.message = "Choose a UTF-8 text file up to 8 KiB."
        picker.beginSheetModal(for: sheet) { [weak self] response in
            guard let self, response == .OK, let file = picker.url, self.session?.canCompose == true else { return }
            do {
                let bytes = try UploadDraft.readFile(file)
                self.body.string = String(decoding: bytes, as: UTF8.self)
                self.title.stringValue = self.suggestedTitle(file.deletingPathExtension().lastPathComponent)
            } catch { self.status.stringValue = "Choose a nonempty UTF-8 text file up to 8 KiB." }
        }
    }
    private func build() {
        sheet.title = "Save context"; sheet.appearance = NSAppearance(named: .darkAqua)
        sheet.backgroundColor = EchoTheme.ink
        title.placeholderString = "Title"; title.setAccessibilityLabel("Note title")
        body.isRichText = false; body.isAutomaticQuoteSubstitutionEnabled = false
        body.isAutomaticDashSubstitutionEnabled = false; body.isAutomaticTextReplacementEnabled = false
        body.font = .systemFont(ofSize: 16); body.textColor = EchoTheme.text
        body.backgroundColor = EchoTheme.ink; body.insertionPointColor = EchoTheme.goldBright
        body.isVerticallyResizable = true; body.autoresizingMask = [.width]
        body.textContainer?.widthTracksTextView = true; body.setAccessibilityLabel("Original note text")
        let scroll = NSScrollView(); scroll.documentView = body; scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        for (label, option) in [("Only me", 0), ("Everyone in my organization", 1)] {
            let chip = ChipButton(title: label, target: self, action: #selector(pickAudience(_:)))
            chip.tag = option; chips.append(chip); audienceRow.addArrangedSubview(chip)
        }
        audienceRow.spacing = 8
        for (button, action) in [(next, #selector(continueToAudience)), (save, #selector(saveNote)),
            (check, #selector(checkSave)), (retry, #selector(retrySave)), (another, #selector(newNote))] {
            button.target = self; button.action = action
        }
        attach.target = self; attach.action = #selector(chooseFile)
        back.target = self; back.action = #selector(goBack)
        closeButton.target = self; closeButton.action = #selector(close)
        closeButton.keyEquivalent = "\u{1b}"
        let actions = NSStackView(views: [back, next, save, closeButton]); actions.spacing = 12
        let recovery = NSStackView(views: [check, retry, another]); recovery.spacing = 8
        let stack = NSStackView(views: [scroll, attach, audienceRow, consequence, availability, status, recovery, actions])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        for label in [consequence, availability, status] { label.textColor = EchoTheme.mutedText; label.font = .systemFont(ofSize: 12.5) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let root = sheet.contentView else { return }; root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 130),
        ])
        for view in [scroll, consequence, availability, status] { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
    }
}


// MARK: - New project sheet

/// Four things and no more: a name, who leads it, who is in it, and anything
/// to start it with.
@MainActor
final class ProjectCreateSheet: NSObject {
    private let sheet = ProjectsWindow(
        contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    private let nameField = NSTextField()
    private let peopleStack = NSStackView()
    private let leadPicker = NSStackView()
    private let addField = NSTextField()
    private let fileStack = NSStackView()
    private let well = DropWellView()

    private var members: [String] = []
    private var lead = ""
    private var files: [String] = []
    private var pickingLead = false
    private var onCreate: ((String, [String], String, [String]) -> Void)?

    override init() {
        super.init()
        build()
    }

    func present(over parent: NSWindow, store: ProjectsStore,
                 onCreate: @escaping (String, [String], String, [String]) -> Void) {
        self.onCreate = onCreate
        lead = store.me
        members = [store.me]
        files = []
        pickingLead = false
        nameField.stringValue = ""
        addField.stringValue = ""
        refresh()
        parent.beginSheet(sheet) { _ in }
        sheet.makeFirstResponder(nameField)
    }

    private func member(_ id: String) -> ProjectMember? {
        ProjectsStore.shared.directory.first { $0.id == id }
    }

    private func refresh() {
        for view in peopleStack.arrangedSubviews {
            peopleStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for id in members {
            guard let person = member(id) else { continue }
            peopleStack.addArrangedSubview(personRow(person))
        }

        for view in leadPicker.arrangedSubviews {
            leadPicker.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        leadPicker.isHidden = !pickingLead
        if pickingLead {
            let label = NSTextField(labelWithString: "Make lead")
            label.font = .systemFont(ofSize: 12)
            label.textColor = EchoTheme.faintText
            leadPicker.addArrangedSubview(label)
            for id in members where id != lead {
                guard let person = member(id) else { continue }
                let chip = ChipButton(title: person.name, target: self, action: #selector(leadChosen(_:)))
                chip.isBordered = false
                chip.chipHeight = 26
                chip.identifier = NSUserInterfaceItemIdentifier(id)
                leadPicker.addArrangedSubview(chip)
            }
        }

        for view in fileStack.arrangedSubviews {
            fileStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for name in files {
            fileStack.addArrangedSubview(fileRow(name))
        }
    }

    private func personRow(_ person: ProjectMember) -> NSView {
        let row = NSView()
        let avatar = ProjectAvatarView()
        avatar.diameter = 28
        avatar.initial = person.initials
        avatar.tint = person.tint
        avatar.translatesAutoresizingMaskIntoConstraints = false
        let name = NSTextField(labelWithString: person.id == ProjectsStore.shared.me ? "\(person.name) (you)" : person.name)
        name.font = .systemFont(ofSize: 14.5)
        name.textColor = EchoTheme.text
        name.lineBreakMode = .byTruncatingTail
        name.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(avatar)
        row.addSubview(name)

        let trailing: NSView
        if person.id == lead {
            let pill = ChipButton(title: "Lead", target: self, action: #selector(toggleLeadPicker))
            pill.isBordered = false
            pill.chipHeight = 24
            pill.selected = true
            trailing = pill
        } else {
            let remove = NSButton()
            remove.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Remove \(person.name)")
            remove.isBordered = false
            remove.contentTintColor = EchoTheme.faintText
            remove.target = self
            remove.action = #selector(removePerson(_:))
            remove.identifier = NSUserInterfaceItemIdentifier(person.id)
            remove.setAccessibilityLabel("Remove \(person.name)")
            trailing = remove
        }
        trailing.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(trailing)

        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = EchoTheme.quietBorder.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(rule)

        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(equalToConstant: 42),
            avatar.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            avatar.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            avatar.widthAnchor.constraint(equalToConstant: 28),
            avatar.heightAnchor.constraint(equalToConstant: 34),
            name.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
            name.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            trailing.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 8),
            trailing.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            trailing.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            rule.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            rule.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        return row
    }

    private func fileRow(_ name: String) -> NSView {
        let row = NSView()
        row.wantsLayer = true
        row.layer?.backgroundColor = EchoTheme.text.withAlphaComponent(0.06).cgColor
        row.layer?.cornerRadius = 6
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "doc", accessibilityDescription: nil)
        icon.contentTintColor = EchoTheme.mutedText
        icon.translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField(labelWithString: name)
        label.font = .systemFont(ofSize: 13.5)
        label.textColor = EchoTheme.text
        label.lineBreakMode = .byTruncatingMiddle
        label.translatesAutoresizingMaskIntoConstraints = false
        let remove = NSButton()
        remove.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Remove \(name)")
        remove.isBordered = false
        remove.contentTintColor = EchoTheme.faintText
        remove.target = self
        remove.action = #selector(removeFile(_:))
        remove.identifier = NSUserInterfaceItemIdentifier(name)
        remove.setAccessibilityLabel("Remove \(name)")
        remove.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(icon)
        row.addSubview(label)
        row.addSubview(remove)
        NSLayoutConstraint.activate([
            row.heightAnchor.constraint(equalToConstant: 32),
            icon.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 8),
            icon.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            label.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            remove.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 8),
            remove.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -6),
            remove.centerYAnchor.constraint(equalTo: row.centerYAnchor),
        ])
        return row
    }

    @objc private func toggleLeadPicker() {
        pickingLead.toggle()
        refresh()
    }

    @objc private func leadChosen(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        lead = id
        pickingLead = false
        refresh()
    }

    @objc private func removePerson(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, id != lead else { return }
        members.removeAll { $0 == id }
        refresh()
    }

    @objc private func removeFile(_ sender: NSButton) {
        guard let name = sender.identifier?.rawValue else { return }
        files.removeAll { $0 == name }
        refresh()
    }

    @objc private func addPerson() {
        let typed = addField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !typed.isEmpty else { return }
        let match = ProjectsStore.shared.directory.first {
            $0.name.lowercased().contains(typed) && !members.contains($0.id)
        }
        guard let match else {
            NSSound.beep()
            return
        }
        members.append(match.id)
        addField.stringValue = ""
        refresh()
    }

    @objc private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.title = "Add files to this project"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: sheet) { [weak self] response in
            guard let self, response == .OK else { return }
            for url in panel.urls where !self.files.contains(url.lastPathComponent) {
                self.files.append(url.lastPathComponent)
            }
            self.refresh()
        }
    }

    @objc private func create() {
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            NSSound.beep()
            sheet.makeFirstResponder(nameField)
            return
        }
        onCreate?(name, members, lead, files)
        sheet.sheetParent?.endSheet(sheet)
    }

    @objc private func cancel() {
        sheet.sheetParent?.endSheet(sheet)
    }

    private func build() {
        sheet.title = "New project"
        sheet.titlebarAppearsTransparent = true
        sheet.appearance = NSAppearance(named: .darkAqua)
        sheet.backgroundColor = EchoTheme.ink

        nameField.placeholderString = "Project name"
        nameField.font = .systemFont(ofSize: 20, weight: .semibold)
        nameField.textColor = EchoTheme.text
        nameField.drawsBackground = true
        nameField.backgroundColor = EchoTheme.surface
        nameField.isBezeled = true
        nameField.bezelStyle = .roundedBezel
        nameField.focusRingType = .none
        nameField.setAccessibilityLabel("Project name")
        nameField.translatesAutoresizingMaskIntoConstraints = false

        let peopleLabel = sectionLabel("PEOPLE")
        peopleStack.orientation = .vertical
        peopleStack.alignment = .leading
        peopleStack.spacing = 0
        leadPicker.spacing = 8
        leadPicker.alignment = .centerY

        addField.placeholderString = "Add people"
        addField.font = .systemFont(ofSize: 14)
        addField.textColor = EchoTheme.text
        addField.backgroundColor = EchoTheme.surface
        addField.isBezeled = true
        addField.bezelStyle = .roundedBezel
        addField.focusRingType = .none
        addField.target = self
        addField.action = #selector(addPerson)
        addField.setAccessibilityLabel("Add people")

        let filesLabel = sectionLabel("FILES")
        fileStack.orientation = .vertical
        fileStack.alignment = .leading
        fileStack.spacing = 6
        fileStack.translatesAutoresizingMaskIntoConstraints = false
        let dropLabel = NSTextField(labelWithString: "Drop files here, or")
        dropLabel.font = .systemFont(ofSize: 13)
        dropLabel.textColor = EchoTheme.faintText
        let chooseButton = PillButton(title: "Choose…", target: self, action: #selector(chooseFiles))
        chooseButton.style = .quiet
        let chooseRow = NSStackView(views: [dropLabel, chooseButton])
        chooseRow.spacing = 8
        chooseRow.alignment = .centerY
        chooseRow.translatesAutoresizingMaskIntoConstraints = false
        well.translatesAutoresizingMaskIntoConstraints = false
        well.addSubview(fileStack)
        well.addSubview(chooseRow)

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.isBordered = false
        cancelButton.contentTintColor = EchoTheme.mutedText
        cancelButton.keyEquivalent = "\u{1b}"
        let createButton = PillButton(title: "Create project", target: self, action: #selector(create))
        createButton.style = .quiet
        createButton.keyEquivalent = "\r"
        let footSpacer = NSView()
        footSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let footer = NSStackView(views: [footSpacer, cancelButton, createButton])
        footer.spacing = 10
        footer.alignment = .centerY

        let content = NSStackView(views: [
            nameField, peopleLabel, peopleStack, leadPicker, addField, filesLabel, well, footer,
        ])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.setCustomSpacing(20, after: nameField)
        content.setCustomSpacing(20, after: addField)
        content.translatesAutoresizingMaskIntoConstraints = false
        guard let root = sheet.contentView else { return }
        root.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
            content.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
            content.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22),
            nameField.widthAnchor.constraint(equalTo: content.widthAnchor),
            nameField.heightAnchor.constraint(equalToConstant: 46),
            peopleStack.widthAnchor.constraint(equalTo: content.widthAnchor),
            addField.widthAnchor.constraint(equalTo: content.widthAnchor),
            addField.heightAnchor.constraint(equalToConstant: 36),
            well.widthAnchor.constraint(equalTo: content.widthAnchor),
            well.heightAnchor.constraint(greaterThanOrEqualToConstant: 110),
            footer.widthAnchor.constraint(equalTo: content.widthAnchor),
            fileStack.leadingAnchor.constraint(equalTo: well.leadingAnchor, constant: 10),
            fileStack.trailingAnchor.constraint(equalTo: well.trailingAnchor, constant: -10),
            fileStack.topAnchor.constraint(equalTo: well.topAnchor, constant: 10),
            chooseRow.centerXAnchor.constraint(equalTo: well.centerXAnchor),
            chooseRow.topAnchor.constraint(greaterThanOrEqualTo: fileStack.bottomAnchor, constant: 8),
            chooseRow.bottomAnchor.constraint(equalTo: well.bottomAnchor, constant: -12),
        ])
    }
}

@MainActor
private func sectionLabel(_ text: String) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 11, weight: .semibold)
    label.textColor = EchoTheme.faintText
    return label
}

// MARK: - Project people sheet

/// Who is in one project, and the two things a lead can do about it.
@MainActor
final class ProjectPeopleSheet: NSObject {
    private let sheet = ProjectsWindow(
        contentRect: NSRect(x: 0, y: 0, width: 420, height: 500),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    private let rows = NSStackView()
    private let addField = NSTextField()
    private let note = NSTextField(labelWithString: "")
    private var projectID = ""
    private var onChange: (() -> Void)?

    override init() {
        super.init()
        build()
    }

    func present(over parent: NSWindow, project: String, onChange: @escaping () -> Void) {
        projectID = project
        self.onChange = onChange
        addField.stringValue = ""
        sheet.title = ProjectsStore.shared.name(of: project)
        refresh()
        parent.beginSheet(sheet) { _ in }
    }

    private func refresh() {
        let store = ProjectsStore.shared
        for view in rows.arrangedSubviews {
            rows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for person in store.members(of: projectID) {
            rows.addArrangedSubview(row(for: person))
        }
        let next = store.candidates(for: projectID).first
        note.stringValue = next.map { "\($0.name) will see everything in this project." }
            ?? "Everyone in my organization is already in this project."
        onChange?()
    }

    private func row(for person: ProjectMember) -> NSView {
        let store = ProjectsStore.shared
        let container = NSView()
        let avatar = ProjectAvatarView()
        avatar.diameter = 28
        avatar.initial = person.initials
        avatar.tint = person.tint
        avatar.translatesAutoresizingMaskIntoConstraints = false
        let name = NSTextField(labelWithString: person.id == store.me ? "\(person.name) (you)" : person.name)
        name.font = .systemFont(ofSize: 14)
        name.textColor = EchoTheme.text
        name.lineBreakMode = .byTruncatingTail
        name.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(avatar)
        container.addSubview(name)

        let trailing: NSView
        if store.isLead(person.id, of: projectID) {
            let pill = ChipButton(title: "Lead", target: nil, action: nil)
            pill.isBordered = false
            pill.chipHeight = 24
            pill.selected = true
            pill.isEnabled = false
            trailing = pill
        } else {
            let menu = NSButton()
            menu.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "More for \(person.name)")
            menu.isBordered = false
            menu.contentTintColor = EchoTheme.mutedText
            menu.target = self
            menu.action = #selector(showRowMenu(_:))
            menu.identifier = NSUserInterfaceItemIdentifier(person.id)
            menu.setAccessibilityLabel("More for \(person.name)")
            trailing = menu
        }
        trailing.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(trailing)

        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = EchoTheme.quietBorder.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(rule)

        NSLayoutConstraint.activate([
            container.heightAnchor.constraint(equalToConstant: 44),
            avatar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            avatar.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            avatar.widthAnchor.constraint(equalToConstant: 28),
            avatar.heightAnchor.constraint(equalToConstant: 34),
            name.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
            name.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            trailing.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 8),
            trailing.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            trailing.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            rule.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            rule.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        return container
    }

    @objc private func showRowMenu(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        let menu = NSMenu()
        let makeLead = NSMenuItem(title: "Make lead", action: #selector(makeLead(_:)), keyEquivalent: "")
        makeLead.target = self
        makeLead.representedObject = id
        menu.addItem(makeLead)
        let remove = NSMenuItem(title: "Remove from project", action: #selector(remove(_:)), keyEquivalent: "")
        remove.target = self
        remove.representedObject = id
        menu.addItem(remove)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func makeLead(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        ProjectsStore.shared.makeLead(id, of: projectID)
        refresh()
    }

    @objc private func remove(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        ProjectsStore.shared.removeMember(id, from: projectID)
        refresh()
    }

    @objc private func add() {
        let typed = addField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !typed.isEmpty else { return }
        let match = ProjectsStore.shared.candidates(for: projectID).first {
            $0.name.lowercased().contains(typed)
        }
        guard let match else {
            NSSound.beep()
            return
        }
        ProjectsStore.shared.addMember(match.id, to: projectID)
        addField.stringValue = ""
        refresh()
    }

    @objc private func done() {
        sheet.sheetParent?.endSheet(sheet)
    }

    private func build() {
        sheet.titlebarAppearsTransparent = true
        sheet.appearance = NSAppearance(named: .darkAqua)
        sheet.backgroundColor = EchoTheme.ink

        let heading = NSTextField(labelWithString: "People")
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.textColor = EchoTheme.text
        let headSpacer = NSView()
        headSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let doneButton = PillButton(title: "Done", target: self, action: #selector(done))
        doneButton.style = .quiet
        doneButton.keyEquivalent = "\r"
        let header = NSStackView(views: [heading, headSpacer, doneButton])
        header.spacing = 10
        header.alignment = .centerY

        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 0

        addField.placeholderString = "Add someone"
        addField.font = .systemFont(ofSize: 14)
        addField.textColor = EchoTheme.text
        addField.backgroundColor = EchoTheme.surface
        addField.isBezeled = true
        addField.bezelStyle = .roundedBezel
        addField.focusRingType = .none
        addField.target = self
        addField.action = #selector(add)
        addField.setAccessibilityLabel("Add someone")
        let addButton = PillButton(title: "Add", target: self, action: #selector(add))
        addButton.style = .quiet
        let addRow = NSStackView(views: [addField, addButton])
        addRow.spacing = 8
        addRow.alignment = .centerY

        note.font = .systemFont(ofSize: 12.5)
        note.textColor = EchoTheme.faintText
        note.lineBreakMode = .byTruncatingTail

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .vertical)

        let content = NSStackView(views: [header, rows, spacer, addRow, note])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 14
        content.translatesAutoresizingMaskIntoConstraints = false
        guard let root = sheet.contentView else { return }
        root.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            content.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            content.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
            header.widthAnchor.constraint(equalTo: content.widthAnchor),
            rows.widthAnchor.constraint(equalTo: content.widthAnchor),
            addRow.widthAnchor.constraint(equalTo: content.widthAnchor),
            addField.heightAnchor.constraint(equalToConstant: 36),
            note.widthAnchor.constraint(equalTo: content.widthAnchor),
        ])
    }
}

// MARK: - The window

@MainActor
final class ProjectsController: NSObject, NSWindowDelegate {
    let window: NSWindow = ProjectsWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 680),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    let answerContainer = NSView()
    let uploads: UploadSession
    private let writeSheet = ProjectWriteSheet()
    private let onAsk: (String) -> Void
    var onConceal: (() -> Void)?
    var onIdentityChanged: (() -> Void)?
    private var observedIdentity: AccountIdentity?
    var onActivateAnswer: (() -> Void)?
    var onResizeAnswer: (() -> Void)?
    var onPeople: (() -> Void)?
    var accountMenu: NSMenu?
    private let sidebar = NSView()
    private var sidebarWidth: NSLayoutConstraint?
    private let sidebarToggle = NSButton()
    private let accountButton = NSButton(title: "Account", target: nil, action: nil)
    private let peopleButton = SidebarRowButton(title: "Organization people…", target: nil, action: nil)
    private let askField = NSTextField()
    private let send = NSButton()
    private let back = NSButton()
    private let results = NSStackView()
    private let scroll = NSScrollView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let empty = NSTextField(wrappingLabelWithString: "Projects · Not live yet\n\nProject spaces, project people, project sharing, and unread updates are not available yet.\n\nYou can save a note, find saved context, or ask about approved decisions.")
    private var mode = Mode.home
    private enum Mode { case home, ask, search }
    private var sidebarOpen = false
    var hasOutstandingMutation: Bool { uploads.hasOutstandingMutation }

    init(uploads: UploadSession? = nil, onAsk: @escaping (String) -> Void) {
        self.uploads = uploads ?? UploadSession(); self.onAsk = onAsk
        super.init(); configure()
        self.uploads.onChange = { [weak self] in self?.refresh() }
        refresh()
    }
    func show() {
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(); uploads.refreshIdentity()
        window.makeFirstResponder(askField)
    }
    func summon() {
        if window.isKeyWindow, window.attachedSheet == nil { conceal(); window.orderOut(nil) }
        else { show() }
    }
    func refreshIdentity() { if window.isVisible && !writeSheet.isPresented { uploads.refreshIdentity() } }
    func conceal() { uploads.conceal(); onConceal?() }
    func accountWillChange() {
        uploads.accountWillChange(); writeSheet.accountWillChange()
        askField.stringValue = ""; mode = .home; refresh()
    }
    func shutdown() { uploads.shutdown(); window.orderOut(nil) }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !hasOutstandingMutation else { return false }
        conceal(); window.orderOut(nil); return false
    }
    func windowDidBecomeKey(_ notification: Notification) {
        refreshIdentity(); if mode == .ask { onActivateAnswer?() }
    }
    func windowDidResignKey(_ notification: Notification) { onConceal?() }
    func windowDidResize(_ notification: Notification) { onResizeAnswer?() }

    private func refresh() {
        if observedIdentity != uploads.identity {
            observedIdentity = uploads.identity
            askField.stringValue = ""; mode = .home; onIdentityChanged?()
        }
        writeSheet.refresh()
        accountButton.title = uploads.identity?.displayName ?? "Account · Sign in"
        peopleButton.isHidden = uploads.identity?.role.lowercased() != "owner"
        status.stringValue = mode == .ask ? "" : uploads.status
        answerContainer.isHidden = mode != .ask
        scroll.isHidden = mode != .search
        empty.isHidden = mode != .home
        back.isHidden = mode == .home
        askField.placeholderString = mode == .search ? "Find saved context" : "Ask about approved decisions"
        send.isEnabled = mode != .search || !uploads.busy
        for view in results.arrangedSubviews { results.removeArrangedSubview(view); view.removeFromSuperview() }
        if mode == .search {
            if let content = uploads.content {
                let heading = NSTextField(wrappingLabelWithString: "\(content.title) · \(content.visibility.label)")
                heading.font = .systemFont(ofSize: 15, weight: .semibold); heading.textColor = EchoTheme.text
                addResult(heading)
                let original = NSTextView(); original.string = content.text
                original.isEditable = false; original.isSelectable = true; original.isRichText = false
                original.font = .systemFont(ofSize: 14); original.textColor = EchoTheme.text
                original.drawsBackground = false; original.textContainerInset = NSSize(width: 8, height: 8)
                original.isVerticallyResizable = true; original.isHorizontallyResizable = false
                original.autoresizingMask = [.width]; original.textContainer?.widthTracksTextView = true
                original.setAccessibilityLabel("Original saved text")
                let reader = NSScrollView(); reader.documentView = original; reader.hasVerticalScroller = true
                reader.drawsBackground = false; addResult(reader)
                reader.heightAnchor.constraint(equalToConstant: 320).isActive = true
            } else {
                for (index, match) in uploads.matches.enumerated() {
                    let card = ProjectEntryView()
                    card.configure(with: ProjectEntry(kind: "ORIGINAL · \(match.visibility.label.uppercased())",
                        title: match.title, body: match.excerpt, when: "", isDecision: false))
                    addResult(card)
                    let open = NSButton(title: "Read original", target: self, action: #selector(openResult(_:)))
                    open.tag = index; open.isEnabled = !uploads.busy; addResult(open)
                }
            }
        }
    }
    private func addResult(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false; results.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: results.widthAnchor).isActive = true
    }
    @objc private func openResult(_ sender: NSButton) {
        guard uploads.matches.indices.contains(sender.tag) else { return }
        uploads.read(uploads.matches[sender.tag].context_id)
    }
    @objc func startWrite() {
        guard !uploads.busy else { return }
        writeSheet.present(over: window, session: uploads)
    }
    @objc private func home() { mode = .home; onConceal?(); refresh() }
    @objc private func findSaved() { mode = .search; onConceal?(); refresh(); window.makeFirstResponder(askField) }
    @objc private func askMode() { mode = .ask; refresh(); window.makeFirstResponder(askField) }
    @objc private func askSubmitted() {
        let question = askField.stringValue
        guard !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if mode == .search { uploads.search(question) }
        else { mode = .ask; refresh(); onAsk(question) }
    }
    @objc private func showPeople() { onPeople?() }
    @objc private func showAccount() {
        accountMenu?.popUp(positioning: nil, at: NSPoint(x: 0, y: accountButton.bounds.height), in: accountButton)
    }
    @objc private func toggleSidebar() {
        sidebarOpen.toggle(); sidebarWidth?.constant = sidebarOpen ? 220 : 0
        sidebar.isHidden = !sidebarOpen
        sidebarToggle.setAccessibilityLabel(sidebarOpen ? "Hide sidebar" : "Show sidebar")
    }
    private func row(_ title: String, symbol: String, action: Selector?) -> SidebarRowButton {
        let button = SidebarRowButton(title: title, target: self, action: action)
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        button.isBordered = false; button.setAccessibilityLabel(title)
        return button
    }
    private func configure() {
        window.title = "ECHO"; window.delegate = self; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 800, height: 580)
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = EchoTheme.ink
        sidebarToggle.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Show sidebar")
        sidebarToggle.target = self; sidebarToggle.action = #selector(toggleSidebar); sidebarToggle.isBordered = false
        sidebarToggle.setAccessibilityLabel("Show sidebar")
        let toggleHost = NSView(frame: NSRect(x: 0, y: 0, width: 42, height: 28))
        sidebarToggle.frame = NSRect(x: 8, y: 2, width: 26, height: 24); toggleHost.addSubview(sidebarToggle)
        let accessory = NSTitlebarAccessoryViewController(); accessory.view = toggleHost; accessory.layoutAttribute = .left
        window.addTitlebarAccessoryViewController(accessory)
        sidebar.wantsLayer = true; sidebar.layer?.backgroundColor = EchoTheme.surface.cgColor; sidebar.isHidden = true
        let newProject = row("New project · Not live yet", symbol: "folder.badge.plus", action: nil)
        newProject.isEnabled = false; newProject.toolTip = "Project creation, project people, project sharing, and unread updates are not live yet."
        peopleButton.image = NSImage(systemSymbolName: "person.2", accessibilityDescription: "Organization people")
        peopleButton.target = self; peopleButton.action = #selector(showPeople); peopleButton.isBordered = false
        let navigation = NSStackView(views: [row("Home", symbol: "house", action: #selector(home)),
            row("Save something…", symbol: "plus.app", action: #selector(startWrite)),
            row("Find saved context", symbol: "magnifyingglass", action: #selector(findSaved)),
            row("Ask ECHO", symbol: "sparkle", action: #selector(askMode)), newProject, peopleButton])
        navigation.orientation = .vertical; navigation.alignment = .leading; navigation.spacing = 4
        accountButton.target = self; accountButton.action = #selector(showAccount); accountButton.isBordered = false
        accountButton.setAccessibilityLabel("Account")
        sidebar.addSubview(navigation); sidebar.addSubview(accountButton)
        back.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Home")
        back.isBordered = false; back.target = self; back.action = #selector(home)
        empty.font = .systemFont(ofSize: 15); empty.textColor = EchoTheme.faintText; empty.alignment = .center
        status.font = .systemFont(ofSize: 12); status.textColor = EchoTheme.mutedText
        results.orientation = .vertical; results.alignment = .leading; results.spacing = 10
        let document = NSView(); document.addSubview(results); scroll.documentView = document
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let bar = BarBackgroundView()
        let write = circleButton(symbol: "plus", label: "Write something", filled: false, target: self, action: #selector(startWrite))
        askField.font = .systemFont(ofSize: 15); askField.textColor = EchoTheme.text
        askField.isBordered = false; askField.drawsBackground = false
        askField.target = self; askField.action = #selector(askSubmitted); askField.setAccessibilityLabel("Ask or find context")
        send.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "Submit")
        send.isBordered = false; send.target = self; send.action = #selector(askSubmitted); send.setAccessibilityLabel("Submit")
        bar.addSubview(write); bar.addSubview(askField); bar.addSubview(send)
        let content = NSView()
        for view in [back, empty, scroll, answerContainer, status, bar] { content.addSubview(view) }
        guard let root = window.contentView else { return }; root.addSubview(sidebar); root.addSubview(content)
        for view in [sidebar, navigation, accountButton, content, back, empty, scroll, document, results,
                     answerContainer, status, bar, write, askField, send] { view.translatesAutoresizingMaskIntoConstraints = false }
        let width = sidebar.widthAnchor.constraint(equalToConstant: 0); sidebarWidth = width
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor), sidebar.topAnchor.constraint(equalTo: root.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor), width,
            navigation.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 12),
            navigation.widthAnchor.constraint(equalToConstant: 196),
            navigation.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 18),
            accountButton.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 12),
            accountButton.widthAnchor.constraint(equalToConstant: 196),
            accountButton.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -18),
            content.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor), content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            content.topAnchor.constraint(equalTo: root.topAnchor), content.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            back.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16), back.topAnchor.constraint(equalTo: content.topAnchor, constant: 10),
            empty.centerXAnchor.constraint(equalTo: content.centerXAnchor), empty.centerYAnchor.constraint(equalTo: content.centerYAnchor, constant: -30),
            empty.widthAnchor.constraint(equalToConstant: 480),
            bar.centerXAnchor.constraint(equalTo: content.centerXAnchor), bar.widthAnchor.constraint(equalToConstant: 520),
            bar.heightAnchor.constraint(equalToConstant: 46), bar.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -28),
            status.leadingAnchor.constraint(equalTo: bar.leadingAnchor), status.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            status.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -10),
            scroll.centerXAnchor.constraint(equalTo: content.centerXAnchor), scroll.widthAnchor.constraint(equalToConstant: 520),
            scroll.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 12), scroll.bottomAnchor.constraint(equalTo: status.topAnchor, constant: -12),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            results.leadingAnchor.constraint(equalTo: document.leadingAnchor), results.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            results.topAnchor.constraint(equalTo: document.topAnchor), results.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            answerContainer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            answerContainer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            answerContainer.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 8), answerContainer.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -12),
            write.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 6), write.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            write.widthAnchor.constraint(equalToConstant: 34), write.heightAnchor.constraint(equalToConstant: 34),
            send.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -6), send.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            send.widthAnchor.constraint(equalToConstant: 34), send.heightAnchor.constraint(equalToConstant: 34),
            askField.leadingAnchor.constraint(equalTo: write.trailingAnchor, constant: 10), askField.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -10),
            askField.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
        ])
        for item in navigation.arrangedSubviews { item.widthAnchor.constraint(equalTo: navigation.widthAnchor).isActive = true }
    }
}
