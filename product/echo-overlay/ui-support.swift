import AppKit
import Foundation

// Shared UI and bounded process primitives; this file compiles without the app bootstrap.

// The warm dark palette published by echobrain.org, applied with native macOS typography.
enum EchoTheme {
    static let ink = NSColor(srgbRed: 36 / 255, green: 34 / 255, blue: 34 / 255, alpha: 1)
    static let surface = NSColor(srgbRed: 29 / 255, green: 28 / 255, blue: 28 / 255, alpha: 1)
    static let inkDeep = NSColor(srgbRed: 23 / 255, green: 22 / 255, blue: 22 / 255, alpha: 1)
    static let text = NSColor(srgbRed: 240 / 255, green: 236 / 255, blue: 230 / 255, alpha: 1)
    static let mutedText = text.withAlphaComponent(0.66)
    static let faintText = text.withAlphaComponent(0.55)
    static let border = text.withAlphaComponent(0.12)
    static let quietBorder = text.withAlphaComponent(0.08)
    static let gold = NSColor(srgbRed: 211 / 255, green: 154 / 255, blue: 76 / 255, alpha: 1)
    static let goldBright = NSColor(srgbRed: 240 / 255, green: 193 / 255, blue: 127 / 255, alpha: 1)
    static let ember = NSColor(srgbRed: 234 / 255, green: 96 / 255, blue: 71 / 255, alpha: 1)
    static let selection = gold.withAlphaComponent(0.36)
}

final class BoundedReader: @unchecked Sendable {
    private let maximumBytes: Int
    private let lock = NSLock()
    private var bytes = Data()
    private(set) var exceeded = false

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    func read(from handle: FileHandle, overflow: @escaping @Sendable () -> Void) {
        defer { try? handle.close() }
        do {
            while let chunk = try handle.read(upToCount: 8 * 1024), !chunk.isEmpty {
                lock.lock()
                if bytes.count + chunk.count > maximumBytes {
                    exceeded = true
                    lock.unlock()
                    overflow()
                    return
                }
                bytes.append(chunk)
                lock.unlock()
            }
        } catch {
            lock.lock()
            exceeded = true
            lock.unlock()
            overflow()
        }
    }

    func data() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return bytes
    }

    func didExceedLimit() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return exceeded
    }
}

final class RunningAsk: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancellationHandler: (@Sendable () -> Void)?
    private var cancelled = false
    private var timedOut = false
    private var outputExceeded = false

    func launch(_ process: Process) throws -> Bool {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return false
        }
        self.process = process
        do {
            try process.run()
            lock.unlock()
            return true
        } catch {
            self.process = nil
            lock.unlock()
            throw error
        }
    }

    func detach(_ process: Process) {
        lock.lock()
        if self.process === process { self.process = nil }
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let active = process
        let handler = cancellationHandler
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
        handler?()
    }

    func attachCancellationHandler(_ handler: @escaping @Sendable () -> Void) {
        lock.lock()
        let shouldCancel = cancelled
        if !shouldCancel { cancellationHandler = handler }
        lock.unlock()
        if shouldCancel { handler() }
    }

    func removeCancellationHandler() {
        lock.lock()
        cancellationHandler = nil
        lock.unlock()
    }

    func timeOut() {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return
        }
        timedOut = true
        let active = process
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func exceedOutputLimit() {
        lock.lock()
        outputExceeded = true
        let active = process
        lock.unlock()
        if active?.isRunning == true { active?.terminate() }
    }

    func state() -> (cancelled: Bool, timedOut: Bool, outputExceeded: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (cancelled, timedOut, outputExceeded)
    }
}

// Self-drawn controls keep their appearance consistent across macOS releases.
final class PillButton: NSButton {
    enum Style {
        case primary
        case quiet
    }

    var style: Style = .primary {
        didSet { needsDisplay = true }
    }

    private var titleFont: NSFont {
        style == .primary
            ? NSFont.systemFont(ofSize: 13, weight: .semibold)
            : NSFont.systemFont(ofSize: 12, weight: .medium)
    }

    private var pillHeight: CGFloat { style == .primary ? 46 : 24 }
    private var horizontalPadding: CGFloat { style == .primary ? 20 : 12 }

    override var intrinsicContentSize: NSSize {
        let width = ceil((title as NSString).size(withAttributes: [.font: titleFont]).width)
        return NSSize(width: width + horizontalPadding * 2, height: pillHeight)
    }

    override var title: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func drawFocusRingMask() {
        pillPath().fill()
    }

    override func draw(_ dirtyRect: NSRect) {
        let fill: NSColor
        let ink: NSColor
        switch style {
        case .primary:
            fill = isHighlighted ? EchoTheme.gold : EchoTheme.goldBright
            ink = EchoTheme.inkDeep
        case .quiet:
            fill = isHighlighted ? EchoTheme.text.withAlphaComponent(0.16) : EchoTheme.text.withAlphaComponent(0.08)
            ink = EchoTheme.text.withAlphaComponent(0.8)
        }
        let alpha: CGFloat = isEnabled ? 1 : 0.38
        fill.withAlphaComponent(fill.alphaComponent * alpha).setFill()
        pillPath().fill()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributes: [NSAttributedString.Key: Any] = [
            .font: titleFont,
            .foregroundColor: ink.withAlphaComponent(ink.alphaComponent * alpha),
            .paragraphStyle: paragraph,
        ]
        let size = (title as NSString).size(withAttributes: attributes)
        let rect = NSRect(
            x: 0,
            y: floor((bounds.height - size.height) / 2),
            width: bounds.width,
            height: ceil(size.height)
        )
        (title as NSString).draw(in: rect, withAttributes: attributes)
    }

    private func pillPath() -> NSBezierPath {
        let radius = bounds.height / 2
        return NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
    }
}
