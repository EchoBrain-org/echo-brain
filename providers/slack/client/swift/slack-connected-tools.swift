import AppKit
import Foundation

// This screen receives only the bounded installed-client tools contract.
struct SlackToolV2: Decodable {
    let provider: String
    let availability: String
    let personal_status: String
    let workspace_id: String?
    let account_id: String?
}
struct SlackToolsResultV2: Decodable {
    let schema_version: Int
    let kind: String
    let organization_id: String
    let membership_id: String
    let tools: [SlackToolV2]
}
struct SlackToolsEnvelopeV2: Decodable { let ok: Bool; let result: SlackToolsResultV2 }

func decodeSlackToolsV2(_ data: Data, membershipID: String?) -> SlackToolsResultV2? {
    guard data.count <= 4096,
          let value = try? JSONDecoder().decode(SlackToolsEnvelopeV2.self, from: data), value.ok,
          value.result.schema_version == 2, value.result.kind == "echo-organization-person-tools",
          membershipID == value.result.membership_id, value.result.tools.count <= 1
    else { return nil }
    for tool in value.result.tools {
        guard tool.provider == "slack" else { return nil }
        if tool.availability == "unavailable" {
            guard tool.personal_status == "unavailable", tool.workspace_id == nil, tool.account_id == nil else { return nil }
        } else {
            guard tool.availability == "enabled", let workspace = tool.workspace_id,
                  workspace.range(of: "^T[A-Z0-9]{2,127}$", options: .regularExpression) != nil,
                  ["linked", "unlinked", "revoked"].contains(tool.personal_status) else { return nil }
            if tool.personal_status == "linked" {
                guard let account = tool.account_id, account.range(of: "^[UW][A-Z0-9]{2,127}$", options: .regularExpression) != nil else { return nil }
            } else if tool.account_id != nil { return nil }
        }
    }
    return value.result
}

enum ConnectedToolsSlackAction: String {
    case none
    case connect
    case disconnect
}

func connectedToolsSlackAction(_ result: ConnectedToolsResult) -> ConnectedToolsSlackAction {
    guard let slack = result.tools.first(where: { $0.tool_id == "slack" }), slack.availability == "enabled" else { return .none }
    return slack.personal_status == "linked" ? .disconnect : .connect
}

func isSlackBrowserExpiry(_ value: String) -> Bool {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if fractional.date(from: value) != nil { return true }
    return ISO8601DateFormatter().date(from: value) != nil
}

private struct SlackBrowserBegin: Decodable {
    let ok: Bool
    let phase: String
    let attempt_id: String
    let expires_at: String
}

private struct SlackBrowserStatus: Decodable {
    let ok: Bool
    let schema_version: Int
    let kind: String
    let attempt_id: String
    let status: String
    let failure_reason: String?

    var isValid: Bool {
        ok && schema_version == 1 && kind == "echo-person-slack-browser-link-status-v1" &&
        attempt_id.range(of: "^sbl_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil &&
        ["pending", "complete", "cancelled", "expired", "failed"].contains(status) &&
        (failure_reason == nil || ["provider_rejected", "provider_unavailable", "identity_conflict", "tool_unavailable"].contains(failure_reason!)) &&
        ((status == "failed") == (failure_reason != nil))
    }
}

@MainActor
final class SlackConnectedToolsController: NSObject, NSWindowDelegate, ConnectedToolsPresenting {
    private let client: AccountClient
    private let gate = AccountRequestGate()
    private var running: AccountRunning?
    private var identity: AccountIdentity?
    private var slackAttemptID: String?
    private var pollWork: DispatchWorkItem?
    private var lastSlackOperationMessage: String?
    private var slackDisconnecting = false
    private var window: NSWindow?
    private let context = NSTextField(wrappingLabelWithString: "")
    private let state = NSTextField(wrappingLabelWithString: "")
    private let refreshButton = NSButton(title: "Refresh", target: nil, action: nil)
    private let linkButton = PillButton(title: "Connect Slack", target: nil, action: nil)
    private let disconnectButton = PillButton(title: "Disconnect Slack", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)

    init(client: AccountClient) { self.client = client; super.init() }

    var hasOutstandingMutation: Bool { slackDisconnecting }

    func show(identity: AccountIdentity) {
        conceal()
        self.identity = identity
        lastSlackOperationMessage = nil
        if window == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "Connected tools"; panel.isReleasedWhenClosed = false
            panel.appearance = NSAppearance(named: .darkAqua); panel.backgroundColor = EchoTheme.ink; panel.delegate = self
            let title = NSTextField(labelWithString: "Connected tools")
            title.font = .systemFont(ofSize: 20, weight: .semibold); title.textColor = EchoTheme.text
            let optional = NSTextField(wrappingLabelWithString: "Connect the tools your organization supports. Slack linking is optional; Ask and Sources already use your ECHO access.")
            optional.font = .systemFont(ofSize: 13); optional.textColor = EchoTheme.mutedText; optional.maximumNumberOfLines = 0
            let buttons = NSStackView(views: [linkButton, disconnectButton, cancelButton, refreshButton])
            buttons.orientation = .horizontal; buttons.spacing = 8
            let stack = NSStackView(views: [title, context, state, buttons, optional])
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
            stack.translatesAutoresizingMaskIntoConstraints = false
            panel.contentView?.addSubview(stack)
            if let content = panel.contentView {
                content.wantsLayer = true; content.layer?.backgroundColor = EchoTheme.ink.cgColor
                NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24), stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24)])
            }
            context.font = .systemFont(ofSize: 12); context.textColor = EchoTheme.mutedText; context.maximumNumberOfLines = 0
            state.font = .systemFont(ofSize: 14); state.textColor = EchoTheme.text; state.maximumNumberOfLines = 0
            for button in [linkButton, disconnectButton, cancelButton, refreshButton] { button.target = self; button.bezelStyle = .rounded }
            linkButton.style = .primary; linkButton.isBordered = false
            disconnectButton.style = .quiet; disconnectButton.isBordered = false
            refreshButton.action = #selector(refresh)
            linkButton.action = #selector(beginLink)
            disconnectButton.action = #selector(disconnectSlack)
            cancelButton.action = #selector(cancelLink); cancelButton.isHidden = true
            window = panel
        }
        context.stringValue = "\(identity.displayName) · \(identity.authority)"
        window?.center(); window?.makeKeyAndOrderFront(nil)
        refresh()
    }

    func conceal() {
        cancelAttemptIfNeeded()
        _ = gate.replace(); running?.cancel(); running = nil; identity = nil
        context.stringValue = ""; state.stringValue = "Status unknown"
        linkButton.isHidden = true; disconnectButton.isHidden = true; cancelButton.isHidden = true
        window?.orderOut(nil)
    }

    func windowWillClose(_ notification: Notification) { conceal() }

    private func request(_ arguments: [String], disconnectMutation: Bool = false, completion: @escaping (Data?) -> Void) {
        running?.cancel()
        let requestID = gate.replace(); let operation = AccountRunning(); running = operation
        refreshButton.isEnabled = false; linkButton.isEnabled = false; disconnectButton.isEnabled = false
        cancelButton.isEnabled = slackAttemptID != nil
        let client = self.client
        let expectedIdentity = self.identity
        DispatchQueue.global(qos: .userInitiated).async {
            var output: Data? = nil
            if case .signedIn(let before) = client.readStatus(operation), before == expectedIdentity {
                output = client.runCaptured(arguments, timeout: 80, running: operation)
                if case .signedIn(let after) = client.readStatus(operation), after == expectedIdentity {} else { output = nil }
            }
            let result = output
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if disconnectMutation { self.slackDisconnecting = false }
                guard self.gate.accepts(requestID), self.identity != nil else { return }
                self.running = nil; self.refreshButton.isEnabled = true; self.linkButton.isEnabled = true; self.disconnectButton.isEnabled = true; self.cancelButton.isEnabled = self.slackAttemptID != nil
                completion(result)
            }
        }
    }

    @objc func refresh() {
        guard slackAttemptID == nil else { return }
        linkButton.isHidden = true; disconnectButton.isHidden = true; cancelButton.isHidden = true; state.stringValue = "Checking organization tools…"
        request(["person", "tools"]) { [weak self] data in
            guard let self else { return }
            guard let data, let result = decodeConnectedTools(data, membershipID: self.identity?.membershipID) else {
                self.showToolsSummary(connectedToolsSummary(nil))
                return
            }
            guard result.tools.first != nil else {
                self.showToolsSummary(connectedToolsSummary(result))
                return
            }
            self.showToolsSummary(connectedToolsSummary(result))
            switch connectedToolsSlackAction(result) {
            case .connect: self.linkButton.isHidden = false
            case .disconnect: self.disconnectButton.isHidden = false
            case .none: break
            }
        }
    }

    @objc private func beginLink() {
        lastSlackOperationMessage = nil
        state.stringValue = "Opening Slack in your browser…"
        request(["person", "slack-connect-begin"]) { [weak self] data in
            guard let self else { return }
            guard let data, let value = try? JSONDecoder().decode(SlackBrowserBegin.self, from: data),
                  value.ok, value.phase == "waiting-for-slack",
                  value.attempt_id.range(of: "^sbl_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
                  isSlackBrowserExpiry(value.expires_at)
            else {
                self.state.stringValue = "Slack browser connection could not start. It may not be enabled for this organization. Ask an owner to enable it or try again."
                return
            }
            self.slackAttemptID = value.attempt_id; self.linkButton.isHidden = true; self.cancelButton.isHidden = false
            self.state.stringValue = "Continue in Slack. ECHO will finish connecting automatically."
            self.pollSlackLink(after: 0.8)
        }
    }

    private func pollSlackLink(after seconds: TimeInterval) {
        pollWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.pollSlackLinkNow() }
        pollWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func pollSlackLinkNow() {
        guard let attempt = slackAttemptID else { return }
        request(["person", "slack-connect-status", "--attempt-id", attempt]) { [weak self] data in
            guard let self else { return }
            guard let data, let status = try? JSONDecoder().decode(SlackBrowserStatus.self, from: data), status.isValid,
                  status.attempt_id == self.slackAttemptID
            else {
                self.cancelAttemptIfNeeded(message: "Slack connection status could not be read. Try connecting again.")
                return
            }
            switch status.status {
            case "pending": self.pollSlackLink(after: 1.5)
            case "complete": self.finishSlackLink("Slack connected.", refresh: true)
            case "cancelled": self.finishSlackLink("Slack connection cancelled.", refresh: true)
            case "expired": self.finishSlackLink("Slack connection expired. Try again.", refresh: true)
            case "failed": self.finishSlackLink(self.failureMessage(status.failure_reason), refresh: true)
            default: self.finishSlackLink("Slack connection could not be completed.", refresh: true)
            }
        }
    }

    @objc private func cancelLink() { cancelAttemptIfNeeded(message: "Slack connection cancelled.") }

    @objc private func disconnectSlack() {
        guard slackAttemptID == nil, confirmSlackDisconnect() else { return }
        lastSlackOperationMessage = nil
        state.stringValue = "Disconnecting Slack…"
        slackDisconnecting = true
        request(["person", "slack-disconnect"], disconnectMutation: true) { [weak self] data in
            guard let self else { return }
            guard let data, let result = decodeSlackToolsV2(data, membershipID: self.identity?.membershipID),
                  let slack = result.tools.first, slack.personal_status != "linked"
            else {
                self.lastSlackOperationMessage = "Slack disconnect outcome could not be confirmed. Checking current status…"
                self.refresh()
                return
            }
            self.lastSlackOperationMessage = "Slack disconnected."
            self.refresh()
        }
    }

    private func confirmSlackDisconnect() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Disconnect Slack?"
        alert.informativeText = "This disconnects your personal Slack account from ECHO. Your ECHO membership and approved records remain. You can connect again later."
        alert.addButton(withTitle: "Disconnect Slack")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func cancelAttemptIfNeeded(message: String? = nil) {
        pollWork?.cancel(); pollWork = nil
        guard let attempt = slackAttemptID else { return }
        _ = gate.replace(); running?.cancel(); running = nil
        slackAttemptID = nil
        // This best-effort request invalidates the in-memory attempt on the
        // Authority before its short expiry, including when the window closes.
        let cancellation = AccountRunning()
        DispatchQueue.global(qos: .utility).async { [client] in
            _ = client.runCaptured(["person", "slack-connect-cancel", "--attempt-id", attempt], timeout: 15, running: cancellation)
        }
        if let message { finishSlackLink(message, refresh: true) }
    }

    private func finishSlackLink(_ message: String, refresh: Bool = false) {
        pollWork?.cancel(); pollWork = nil; slackAttemptID = nil
        lastSlackOperationMessage = message; state.stringValue = message; cancelButton.isHidden = true
        if refresh { self.refresh() } else { linkButton.isHidden = false }
    }

    private func showToolsSummary(_ summary: String) {
        if let message = lastSlackOperationMessage {
            state.stringValue = "\(message)\n\n\(summary)"
        } else {
            state.stringValue = summary
        }
    }

    private func failureMessage(_ reason: String?) -> String {
        switch reason {
        case "provider_rejected": return "Slack declined the connection. Try again and approve the request in Slack."
        case "provider_unavailable": return "Slack is temporarily unavailable. Try again shortly."
        case "identity_conflict": return "That Slack account is already linked to another ECHO account."
        case "tool_unavailable": return "Slack is no longer enabled for this organization."
        default: return "Slack connection could not be completed."
        }
    }
}
