import Foundation

public enum AgentKind: String, Codable, Sendable {
    case claude
    case grok
    case codex
    case pi
    case antigravity
    case markdown
    case shell

    public var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .grok: return "Grok CLI"
        case .codex: return "OpenAI Codex"
        case .pi: return "Pi"
        case .antigravity: return "Antigravity"
        case .markdown: return "Markdown"
        case .shell: return "Terminal"
        }
    }

    public var systemIcon: String {
        switch self {
        case .claude: return "sparkles"
        case .grok: return "bolt.fill"
        case .codex: return "cpu"
        case .pi: return "number"
        case .antigravity: return "atom"
        case .markdown: return "doc.text.fill"
        case .shell: return "terminal.fill"
        }
    }
}

public enum AgentLifecycleState: String, Codable, Sendable {
    case needsInput = "needs_input"
    case running = "running"
    case unread = "unread"
    case idle = "idle"

    public var statusDotColorName: String {
        switch self {
        case .needsInput: return "orange"
        case .running: return "blue"
        case .unread: return "purple"
        case .idle: return "green"
        }
    }
}

public struct TuiOption: Identifiable, Codable, Sendable {
    public var id: String { "\(index ?? -1)_\(label)" }
    public let index: Int?
    public let label: String
    public let isSelected: Bool

    public init(index: Int?, label: String, isSelected: Bool = false) {
        self.index = index
        self.label = label
        self.isSelected = isSelected
    }
}

public struct DetectedPrompt: Codable, Sendable {
    public let title: String
    public let kind: String
    public let options: [TuiOption]

    public init(title: String, kind: String, options: [TuiOption]) {
        self.title = title
        self.kind = kind
        self.options = options
    }
}

public struct SubagentItem: Identifiable, Codable, Sendable {
    public let id: String
    public let title: String
    public let status: String

    public init(id: String, title: String, status: String) {
        self.id = id
        self.title = title
        self.status = status
    }
}

public struct AgentTelemetry: Codable, Sendable {
    public let model: String?
    public let contextPercent: String?
    public let costSession: String?
    public let burnRate: String?
    public let compactions: String?
    public let subagents: [SubagentItem]

    public init(
        model: String? = nil,
        contextPercent: String? = nil,
        costSession: String? = nil,
        burnRate: String? = nil,
        compactions: String? = nil,
        subagents: [SubagentItem] = []
    ) {
        self.model = model
        self.contextPercent = contextPercent
        self.costSession = costSession
        self.burnRate = burnRate
        self.compactions = compactions
        self.subagents = subagents
    }
}

public struct SurfaceItem: Identifiable, Codable, Sendable {
    public let id: String
    public let workspaceId: String?
    public let title: String
    public let kind: String
    public let cwd: String?
    public let isFocused: Bool
    public let agentKind: AgentKind
    public let sessionId: String?
    public let state: AgentLifecycleState
    public let hasHumanObligation: Bool
    public let transcriptPath: String?
    public let detectedPrompt: DetectedPrompt?
    public let telemetry: AgentTelemetry?

    public init(
        id: String,
        workspaceId: String? = nil,
        title: String,
        kind: String = "terminal",
        cwd: String? = nil,
        isFocused: Bool = false,
        agentKind: AgentKind = .shell,
        sessionId: String? = nil,
        state: AgentLifecycleState = .idle,
        hasHumanObligation: Bool = false,
        transcriptPath: String? = nil,
        detectedPrompt: DetectedPrompt? = nil,
        telemetry: AgentTelemetry? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.kind = kind
        self.cwd = cwd
        self.isFocused = isFocused
        self.agentKind = agentKind
        self.sessionId = sessionId
        self.state = state
        self.hasHumanObligation = hasHumanObligation
        self.transcriptPath = transcriptPath
        self.detectedPrompt = detectedPrompt
        self.telemetry = telemetry
    }
}

public struct WorkspaceItem: Identifiable, Codable, Sendable {
    public let id: String
    public let title: String
    public let cwd: String?
    public let isPinned: Bool
    public let isSelected: Bool
    public let unreadCount: Int
    public let hasUnread: Bool
    public let state: AgentLifecycleState
    public let preview: String
    public let surfaces: [SurfaceItem]

    public init(
        id: String,
        title: String,
        cwd: String? = nil,
        isPinned: Bool = false,
        isSelected: Bool = false,
        unreadCount: Int = 0,
        hasUnread: Bool = false,
        state: AgentLifecycleState = .idle,
        preview: String = "",
        surfaces: [SurfaceItem] = []
    ) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.isPinned = isPinned
        self.isSelected = isSelected
        self.unreadCount = unreadCount
        self.hasUnread = hasUnread
        self.state = state
        self.preview = preview
        self.surfaces = surfaces
    }
}

public struct DashboardSnapshot: Codable, Sendable {
    public let workspaces: [WorkspaceItem]
    public let totalSurfaces: Int
    public let needsInputCount: Int
    public let runningCount: Int
    public let cmuxConnected: Bool

    public init(
        workspaces: [WorkspaceItem] = [],
        totalSurfaces: Int = 0,
        needsInputCount: Int = 0,
        runningCount: Int = 0,
        cmuxConnected: Bool = true
    ) {
        self.workspaces = workspaces
        self.totalSurfaces = totalSurfaces
        self.needsInputCount = needsInputCount
        self.runningCount = runningCount
        self.cmuxConnected = cmuxConnected
    }
}
