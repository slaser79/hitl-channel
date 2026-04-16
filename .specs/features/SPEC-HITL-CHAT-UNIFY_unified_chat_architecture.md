---
id: SPEC-HITL-CHAT-UNIFY
title: "Unified Chat Architecture & hitl_agents Modularization"
status: "Draft"
owner: "hitl-app"
priority: P1
created_by: cos
created_at: 2026-03-21
last_updated: 2026-03-21
revision: 2
products: ["hitl-app", "hitl-channel"]
type: feature
depends_on: ["SPEC-CC-CHANNEL-265"]
---

# 1. Executive Summary

Rationalize the four distinct chat UIs in hitl-app into a unified architecture with composable channel abstractions, consistent UX, session management, and image support. Extract core chat logic from the `hitl_agents` god-package into a dedicated `hitl_chat` package. Run modularization as an independent parallel track.

---

# 2. The Four Chat Types Today

| # | Chat Type | Package | Transport | Pattern | Sessions | Shared Components |
|---|-----------|---------|-----------|---------|----------|-------------------|
| 1 | **Local Chat Agents** | `hitl_agents` | Local LLM | Bidirectional streaming | Yes (per agent) | `SharedMessageBubble`, `ChatScrollMixin` |
| 2 | **OpenClaw** | `hitl_openclaw` | WebSocket frames | Bidirectional streaming + tools | Yes (session picker) | `SharedMessageBubble`, `ChatScrollMixin` |
| 3 | **Claude Code Channel** | `hitl_agents` | HTTP + WS via hitl-channel | Bidirectional via MCP channel | **No** (flat, no history) | **None** (custom inline) |
| 4 | **HITL Relay (Pseudo-Chat)** | `hitl_requests` | hitlrelay.app WS + API | Unidirectional request→response | No (task queue) | **None** (inbox cards) |

### Key Problems

- **Claude Code** duplicates bubble/scroll/input code, has no sessions, no images, no markdown
- **No shared chat package** — chat logic is split across `hitl_agents`, `hitl_openclaw`, and `hitl_design_system`
- **hitl_agents** is a 180-file god-package mixing chat, tools, workflows, memory, MCP, skills, BYOK
- **3 different message models** with no shared adapter layer

---

# 3. CEO Business Outcomes

| # | Outcome | Measurable Criteria |
|---|---------|---------------------|
| BO-1 | All chat types feel like the same app | Shared bubbles, scroll, compose, avatars, markdown across all 3 conversational types |
| BO-2 | Claude Code sessions are persistent and browsable | Session picker, history preserved across reconnects, session auto-titled from first message |
| BO-3 | Users can send images to Claude Code | Image picker in compose, base64 via hitl-channel, received by Claude Code as multimodal content |
| BO-4 | Adding a new channel type requires 1 adapter class (<200 lines), 1 test file, 0 changes to UnifiedChatScreen | Verified by adding a mock channel in tests |
| BO-5 | Core chat logic extracted into `hitl_chat` package | Chat screens, services, and models no longer in hitl_agents |

---

# 4. Unified Architecture

## 4.1 Composable Channel Interface (Revised — addresses P0 #1)

The interface is split into **composable parts** rather than one monolithic abstract class. Only `ChannelDataSource` is required. Connection and discovery are optional mixins.

```dart
// In hitl_core

/// Required: every channel provides messages and session management
abstract class ChannelDataSource {
  String get channelId;
  String get displayName;
  String? get avatarUrl;
  IconData get icon;
  ChannelType get type;
  ChannelCapabilities get capabilities;

  // Sessions (all channels support sessions)
  Stream<List<ChatSession>> watchSessions();
  Future<ChatSession> createSession();
  Future<void> deleteSession(String sessionId);

  // Messaging
  Future<SendResult> sendMessage(String sessionId, String content, {
    List<Attachment>? attachments,
    Map<String, dynamic>? metadata,
  });
  Stream<List<MessageDisplayModel>> watchMessages(String sessionId);
}

/// Optional: channels with remote connections
mixin ChannelConnection on ChannelDataSource {
  ConnectionState get connectionState;
  Stream<ConnectionState> get connectionStream;
  Future<void> connect({Map<String, dynamic>? params});
  Future<void> disconnect();
}

/// Optional: channels with mDNS/network discovery
mixin ChannelDiscovery on ChannelDataSource {
  Stream<List<DiscoveredInstance>> watchDiscovery();
  Future<void> startDiscovery();
  Future<void> stopDiscovery();
}

/// Optional: channels that support streaming responses
mixin ChannelStreaming on ChannelDataSource {
  Stream<StreamingUpdate> get streamingUpdates;
  Future<void> cancelStreaming(String sessionId);
}

/// Optional: channels with approval/HITL flows
mixin ChannelApproval on ChannelDataSource {
  Future<void> approveMessage(String messageId);
  Future<void> denyMessage(String messageId);
}
```

**Why this works:**
- Local chat: `ChannelDataSource` + `ChannelStreaming` + `ChannelApproval` (no connection — always local)
- OpenClaw: `ChannelDataSource` + `ChannelConnection` + `ChannelDiscovery` + `ChannelStreaming`
- Claude Code: `ChannelDataSource` + `ChannelConnection` + `ChannelDiscovery`
- Future hitl-cli: `ChannelDataSource` + `ChannelConnection`

## 4.2 Use MessageDisplayModel directly (Revised — addresses P0 #2)

`MessageDisplayModel` already exists in `hitl_design_system` and is consumed by `SharedMessageBubble`. Instead of creating a duplicate `ChannelMessage`, each channel adapter maps directly to `MessageDisplayModel`. No extra intermediate model.

```dart
// Each channel's watchMessages() returns Stream<List<MessageDisplayModel>>
// Adapters live alongside each channel implementation:
//   - ClaudeCodeMessageAdapter.toDisplayModel(record) → MessageDisplayModel
//   - OpenClawMessageAdapter.toDisplayModel(msg) → MessageDisplayModel  (already exists!)
//   - LocalChatMessageAdapter.toDisplayModel(chatMsg) → MessageDisplayModel  (already exists as MessageBubble wrapper)
```

## 4.3 ChatSession Model

```dart
@freezed
class ChatSession with _$ChatSession {
  const factory ChatSession({
    required String id,
    required String channelId,
    required String title,
    required DateTime createdAt,
    DateTime? lastMessageAt,
    @Default(0) int messageCount,
  }) = _ChatSession;
}
```

All 3 conversational channels support sessions. Session title auto-generated from first message content.

## 4.4 SendResult (Revised — addresses P1 #6)

```dart
@freezed
class SendResult with _$SendResult {
  const factory SendResult.success({String? messageId}) = _Success;
  const factory SendResult.failed({required String error, bool retriable}) = _Failed;
  const factory SendResult.pending() = _Pending;  // Optimistic — awaiting server confirm
}
```

## 4.5 ChannelCapabilities

```dart
class ChannelCapabilities {
  final bool supportsImages;
  final bool supportsVoice;
  final bool supportsAttachments;
  final bool supportsChoices;
  final bool supportsThinkingLevel;
  final bool supportsStreaming;
  final bool supportsMultiSelect;
  final bool supportsApproval;      // Added — addresses P1 #5
  final bool supportsMarkdown;
  final int maxImageSizeBytes;       // Added — addresses P1 #7 (default: 5MB)
}
```

## 4.6 UnifiedChatScreen

```dart
// In hitl_chat (NEW package, not hitl_design_system)
class UnifiedChatScreen extends ConsumerStatefulWidget {
  final ChannelDataSource channel;
  final String sessionId;

  // Slot pattern for channel-specific UI (addresses P1 #5)
  final Widget Function(BuildContext, ConnectionState)? connectionStatusBuilder;
  final Widget? headerWidget;         // Agent picker, session picker, etc.
  final List<Widget> Function(BuildContext, MessageDisplayModel)? messageActions;
    // Approval buttons, copy, redo — injected per channel type
}
```

Built-in (from capabilities):
- `SharedMessageBubble` for all messages
- `ChatScrollMixin` with scroll FAB
- Configurable compose area (image picker, voice, thinking — based on `capabilities`)
- Markdown rendering
- Choices rendering
- Session picker (shared across all channels)
- Streaming cursor (when `ChannelStreaming` is mixed in)
- Approval buttons (when `ChannelApproval` is mixed in, via `messageActions` slot)

---

# 5. Channel Implementations

## 5.1 ClaudeCodeChannel

```dart
class ClaudeCodeChannel extends ChannelDataSource
    with ChannelConnection, ChannelDiscovery {

  ChannelCapabilities get capabilities => ChannelCapabilities(
    supportsImages: true,
    supportsVoice: false,
    supportsAttachments: false,
    supportsChoices: true,
    supportsThinkingLevel: false,
    supportsStreaming: false,
    supportsMultiSelect: true,
    supportsApproval: false,
    supportsMarkdown: true,
    maxImageSizeBytes: 5 * 1024 * 1024,  // 5MB — compressed JPEG
  );
}
```

## 5.2 OpenClawChannel

```dart
class OpenClawChannel extends ChannelDataSource
    with ChannelConnection, ChannelDiscovery, ChannelStreaming {

  ChannelCapabilities get capabilities => ChannelCapabilities(
    supportsImages: true,
    supportsVoice: true,
    supportsAttachments: true,
    supportsChoices: false,
    supportsThinkingLevel: true,
    supportsStreaming: true,
    supportsMultiSelect: false,
    supportsApproval: false,
    supportsMarkdown: true,
    maxImageSizeBytes: 10 * 1024 * 1024,
  );
}
```

## 5.3 LocalAgentChannel

```dart
class LocalAgentChannel extends ChannelDataSource
    with ChannelStreaming, ChannelApproval {

  // No ChannelConnection — always local, always available

  ChannelCapabilities get capabilities => ChannelCapabilities(
    supportsImages: true,
    supportsVoice: true,
    supportsAttachments: true,
    supportsChoices: true,
    supportsThinkingLevel: false,
    supportsStreaming: true,
    supportsMultiSelect: true,
    supportsApproval: true,
    supportsMarkdown: true,
    maxImageSizeBytes: 10 * 1024 * 1024,
  );
}
```

## 5.4 HITL Relay

**Decision:** Keep as separate inbox UI. The relay is a task queue, not a conversation. Shares choice/text response widgets (extracted to `hitl_design_system`) but not forced into `ChannelDataSource`.

---

# 6. hitl-channel Image Support

```typescript
// POST / body supports image attachments
{
  "message": "Check this screenshot",
  "sender_id": "ceo",
  "attachments": [
    { "type": "image", "media_type": "image/jpeg", "data": "<base64>" }
  ]
}
```

**Constraints:**
- Max image size: 5MB after compression
- hitl-app compresses to 1024x1024 max, 85% JPEG quality (matches OpenClaw)
- hitl-channel validates size before forwarding to MCP notification
- If image exceeds limit: reject with 413 Payload Too Large
- Channel notification uses MCP content block format: `{ type: "image", source: { type: "base64", ... } }`

---

# 7. New Package: `hitl_chat`

**Core chat logic extracted from hitl_agents into a dedicated package.**

```
packages/hitl_chat/
├── lib/src/
│   ├── channels/
│   │   ├── channel_data_source.dart       # Core interface
│   │   ├── channel_connection.dart        # Connection mixin
│   │   ├── channel_discovery.dart         # Discovery mixin
│   │   ├── channel_streaming.dart         # Streaming mixin
│   │   ├── channel_approval.dart          # Approval mixin
│   │   └── channel_capabilities.dart      # Capabilities model
│   ├── models/
│   │   ├── chat_session.dart              # Session model
│   │   └── send_result.dart               # Send result
│   ├── presentation/
│   │   ├── unified_chat_screen.dart       # The shared screen
│   │   ├── session_picker.dart            # Shared session picker
│   │   └── compose/
│   │       ├── unified_compose_area.dart  # Configurable input
│   │       └── image_picker_button.dart
│   └── adapters/
│       └── (adapter base utilities)
├── test/
│   ├── unified_chat_screen_test.dart
│   ├── session_picker_test.dart
│   └── mock_channel.dart                  # Shared mock
└── pubspec.yaml
    # depends on: hitl_core, hitl_design_system
    # does NOT depend on: hitl_agents, hitl_openclaw
```

**Why a new package (not hitl_design_system)?**
- `hitl_design_system` is pure UI atoms (buttons, themes, mixins) — no business logic
- `hitl_chat` has business logic (sessions, send, capabilities) + assembled screens
- Clean dependency: `hitl_agents` depends on `hitl_chat`, not the other way around

---

# 8. Two Independent Tracks

## Track A: UI Unification (Chat)

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **A1** | Create `hitl_chat` package with interfaces, models, `UnifiedChatScreen` | New package, tested with mock channel |
| **A2** | Implement `ClaudeCodeChannel` + sessions + image support | CC chat migrated to unified screen |
| **A3** | Add image support to hitl-channel TypeScript server | Multipart/base64 in bridge |
| **A4** | Implement `OpenClawChannel` adapter | OC chat migrated to unified screen |
| **A5** | Implement `LocalAgentChannel` adapter | Local chat migrated (highest risk) |
| **A6** | Unify discovery services, agent grid, remove old screens | Cleanup |

**Rollback strategy (addresses P2 #9):** Feature flag per channel type. Both old and new screens coexist during migration. `ChannelUseUnifiedChat.claudeCode`, `.openclaw`, `.local` flags in app settings. Old screens deleted only after 1 release cycle with zero regressions.

## Track B: hitl_agents Modularization (Independent)

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **B1** | Extract `hitl_skills` (skills catalog, import/export) | ~8 files, ~5 tests |
| **B2** | Extract `hitl_memory` (memory, embeddings, vector search) | ~10 files, ~8 tests |
| **B3** | Extract `hitl_mcp` (MCP server management) | ~8 files, ~5 tests |
| **B4** | Move Claude Code channel code from hitl_agents → hitl_chat | Depends on A2 |
| **B5** | Extract `hitl_byok` (BYOK provider support) | ~7 files, ~6 tests |
| **B6** | Extract `hitl_workflows` (workflow engine) | ~35 files, ~3 tests |
| **B7** | Split `internal_tools_service.dart` god-class | 9000 lines → focused modules |
| **B8** | Layer `chat_agent_service.dart` | 5500 lines → execution, routing, prompt, response |

**Track B can start immediately** — it has no dependency on Track A except B4.

---

# 9. Streaming Architecture (Revised — addresses P1 #4)

```dart
/// Channels that stream emit updates via this interface
mixin ChannelStreaming on ChannelDataSource {
  /// Stream of incremental updates for the active streaming message
  Stream<StreamingUpdate> get streamingUpdates;

  /// Cancel an in-progress streaming response
  Future<void> cancelStreaming(String sessionId);
}

@freezed
class StreamingUpdate with _$StreamingUpdate {
  /// Content delta (append to existing message)
  const factory StreamingUpdate.delta({
    required String sessionId,
    required String messageId,
    required String contentDelta,
  }) = _Delta;

  /// Streaming started
  const factory StreamingUpdate.started({
    required String sessionId,
    required String messageId,
  }) = _Started;

  /// Streaming completed — final message available via watchMessages
  const factory StreamingUpdate.completed({
    required String sessionId,
    required String messageId,
  }) = _Completed;

  /// Tool activity during streaming
  const factory StreamingUpdate.toolActivity({
    required String sessionId,
    required String messageId,
    required ChatToolCall toolCall,
    ChatToolResponse? toolResponse,
  }) = _ToolActivity;
}
```

`UnifiedChatScreen` listens to `streamingUpdates` and feeds deltas to `StreamingTextController` (already in design system). Non-streaming channels (Claude Code) simply don't mix in `ChannelStreaming` — messages arrive complete.

---

# 10. Test Strategy

## Principles
1. **Tests travel with code** — extracted packages take their tests
2. **Mock channel for widget tests** — `MockChannelDataSource` in `hitl_chat/test/`
3. **Adapter tests per channel** — verify model → `MessageDisplayModel` mapping
4. **Feature flag integration tests** — verify old/new screens side-by-side
5. **No regression gate** — CI runs both old and new screen tests during migration

## Test Organization

```
hitl_chat/test/
  ├── unified_chat_screen_test.dart     # Widget tests with MockChannel
  ├── session_picker_test.dart
  ├── compose_area_test.dart
  └── mock_channel.dart                 # Shared mock (exported for other packages)

hitl_agents/test/
  ├── channels/
  │   └── local_agent_channel_test.dart  # Adapter + approval flow tests
  └── services/                          # Remaining (shrinking) service tests

hitl_openclaw/test/
  └── channels/
      └── openclaw_channel_test.dart     # Adapter + streaming tests

hitl_agents/test/ (Claude Code — moves to hitl_chat after B4)
  └── channels/
      └── claude_code_channel_test.dart  # Adapter + session tests
```

## Coverage Targets
- `hitl_chat` package: >80% (new code, test-first)
- Adapter classes: 100% (pure mapping logic)
- `UnifiedChatScreen` widget tests: All capability combinations tested
- Regression: Zero increase in failing tests per phase

---

# 11. Acceptance Criteria

- [ ] `hitl_chat` package exists with `ChannelDataSource`, mixins, `UnifiedChatScreen`
- [ ] All 3 conversational chat types use `UnifiedChatScreen` (behind feature flags during migration)
- [ ] Claude Code has session picker with browsable history
- [ ] Images can be sent to Claude Code from hitl-app (5MB max, compressed)
- [ ] `SharedMessageBubble` renders all message types consistently
- [ ] `ChatScrollMixin` handles scroll for all chat types
- [ ] Compose area adapts based on `ChannelCapabilities` (images, voice, thinking, choices)
- [ ] Approval UI plugs in via `messageActions` slot (local chat only)
- [ ] Streaming works via `ChannelStreaming` mixin + `StreamingTextController`
- [ ] HITL relay remains separate (inbox pattern)
- [ ] Feature flags control old vs new screen per channel type
- [ ] Old screens removed only after 1 release cycle with zero regressions
- [ ] `hitl_skills`, `hitl_memory`, `hitl_mcp` extracted (Track B, independent)
- [ ] Adding a new channel: 1 adapter class (<200 lines), 1 test file, 0 changes to UnifiedChatScreen

---

# 12. Open Questions

1. Should `hitl_chat` also own the `SharedMessageBubble` (move from design system)?
2. Should the session picker be identical across all channels or allow channel-specific customization?
3. Should we add hitl-cli as a potential future channel type in the capabilities enum?
4. What's the timeline expectation — one mission or multiple sequential missions?
