import SwiftUI

struct ChatInputDock: View {
  @Binding var prompt: String
  @Binding var isAttachmentMenuPresented: Bool

  let statusLine: String
  let errorMessage: String?
  let isEnabled: Bool
  let onSend: () -> Void
  let onAttachment: (AttachmentAction) -> Void

  var body: some View {
    VStack(spacing: 10) {
      statusView

      ChatInputBar(
        prompt: $prompt,
        isAttachmentMenuPresented: $isAttachmentMenuPresented,
        isEnabled: isEnabled,
        onSend: onSend
      )
    }
    .overlay(alignment: .bottomLeading) {
      if isAttachmentMenuPresented {
        AttachmentActionPanel(onSelect: onAttachment)
          .transition(.scale(scale: 0.96, anchor: .bottomLeading).combined(with: .opacity))
          .padding(.bottom, 72)
          .padding(.leading, 4)
      }
    }
    .padding(.horizontal, 22)
    .padding(.top, 12)
    .padding(.bottom, 8)
    .background {
      Rectangle()
        .fill(.ultraThinMaterial)
        .mask(
          LinearGradient(
            colors: [.black.opacity(0), .black, .black],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .ignoresSafeArea()
    }
    .animation(.spring(response: 0.28, dampingFraction: 0.86), value: isAttachmentMenuPresented)
  }

  @ViewBuilder
  private var statusView: some View {
    if let errorMessage {
      Text(errorMessage)
        .font(.footnote)
        .foregroundStyle(.red)
        .lineLimit(2)
        .multilineTextAlignment(.center)
    } else if !statusLine.isEmpty {
      Text(statusLine)
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }
}

struct AttachmentAction: Identifiable, Equatable {
  let id: String
  let title: String
  let systemImage: String

  static let camera = AttachmentAction(id: "camera", title: "相机", systemImage: "camera")
  static let photos = AttachmentAction(id: "photos", title: "照片", systemImage: "photo")
  static let files = AttachmentAction(id: "files", title: "文件", systemImage: "paperclip")
  static let plugins = AttachmentAction(id: "plugins", title: "插件", systemImage: "link")

  static let allCases: [AttachmentAction] = [.camera, .photos, .files, .plugins]
}

private struct ChatInputBar: View {
  @Binding var prompt: String
  @Binding var isAttachmentMenuPresented: Bool

  let isEnabled: Bool
  let onSend: () -> Void

  @FocusState private var isPromptFocused: Bool

  private var trimmedPrompt: String {
    prompt.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    isEnabled && !trimmedPrompt.isEmpty
  }

  var body: some View {
    HStack(alignment: .bottom, spacing: 10) {
      Button(action: toggleAttachmentMenu) {
        Image(systemName: isAttachmentMenuPresented ? "xmark" : "plus")
          .font(.system(size: 27, weight: .regular))
          .frame(width: 38, height: 38)
          .foregroundStyle(.primary)
          .contentTransition(.symbolEffect(.replace))
      }
      .accessibilityLabel(isAttachmentMenuPresented ? "收起附件" : "展开附件")
      .buttonStyle(.plain)

      TextField("向 CodeBuddy 提问", text: $prompt, axis: .vertical)
        .font(.body)
        .lineLimit(1...5)
        .textInputAutocapitalization(.sentences)
        .autocorrectionDisabled()
        .focused($isPromptFocused)
        .submitLabel(.send)
        .onSubmit(sendIfPossible)
        .padding(.vertical, 9)

      Button(action: insertNewline) {
        Image(systemName: "arrow.turn.down.left")
          .font(.system(size: 20, weight: .semibold))
          .frame(width: 36, height: 36)
          .foregroundStyle(.primary)
      }
      .accessibilityLabel("换行")
      .buttonStyle(.plain)

      Button(action: sendIfPossible) {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 30, weight: .semibold))
          .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.45))
      }
      .accessibilityLabel("发送")
      .buttonStyle(.plain)
      .disabled(!canSend)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(.ultraThinMaterial)
    .clipShape(Capsule())
    .shadow(color: .black.opacity(0.10), radius: 24, x: 0, y: 8)
    .onTapGesture {
      isPromptFocused = true
    }
  }

  private func toggleAttachmentMenu() {
    isAttachmentMenuPresented.toggle()
  }

  private func insertNewline() {
    prompt.append("\n")
    isPromptFocused = true
  }

  private func sendIfPossible() {
    guard canSend else {
      isPromptFocused = true
      return
    }
    onSend()
    isPromptFocused = true
  }
}

private struct AttachmentActionPanel: View {
  let onSelect: (AttachmentAction) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(AttachmentAction.allCases) { action in
        Button {
          onSelect(action)
        } label: {
          HStack(spacing: 18) {
            Image(systemName: action.systemImage)
              .font(.system(size: 21, weight: .medium))
              .frame(width: 44, height: 44)
              .foregroundStyle(.primary)
              .background(Color(.secondarySystemFill), in: Circle())

            Text(action.title)
              .font(.title3.weight(.medium))
              .foregroundStyle(.primary)

            Spacer(minLength: 0)
          }
          .padding(.horizontal, 18)
          .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
      }
    }
    .frame(width: 300)
    .padding(.vertical, 18)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 26, style: .continuous)
        .stroke(Color.white.opacity(0.35), lineWidth: 1)
    }
    .shadow(color: .black.opacity(0.14), radius: 30, x: 0, y: 16)
  }
}
