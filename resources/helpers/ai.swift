// Acrofox Apple Intelligence helper — on-device summarize / Q&A / rewrite via
// the FoundationModels framework (macOS 15.1+ / Xcode 16+).
//
// Usage:
//   ai-bin summarize <path-to-text-file>
//   ai-bin qa        <path-to-text-file> <question>
//   ai-bin qa        <path-to-text-file> --extra-file <path-to-question-file>
//   ai-bin rewrite   <path-to-text-file> <style>
//   ai-bin rewrite   <path-to-text-file> --extra-file <path-to-style-file>
//
// Output: JSON on stdout: { "ok": true, "text": "..." }
// On failure: exit != 0 + stderr line.
//
// Build: swiftc -O ai.swift -o ai-bin    (needs full Xcode, not just CLT).

import Foundation
import FoundationModels

func emit(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write("\(msg)\n".data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count >= 3 else {
    emit("usage: ai-bin <summarize|qa|rewrite> <text-file> [arg]", 2)
}

let mode = CommandLine.arguments[1]
let path = CommandLine.arguments[2]
let extraArg: String?
if CommandLine.arguments.count >= 5 && CommandLine.arguments[3] == "--extra-file" {
    do {
        extraArg = try String(contentsOfFile: CommandLine.arguments[4], encoding: .utf8)
    } catch {
        emit("failed to read extra file: \(error.localizedDescription)", 3)
    }
} else {
    extraArg = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : nil
}

let content: String
do {
    content = try String(contentsOfFile: path, encoding: .utf8)
} catch {
    emit("failed to read text file: \(error.localizedDescription)", 3)
}

// Keep prompts short so a 200-page PDF doesn't blow the context. Foundation
// Models on-device ~8k token window; we cap the input at ~16k characters
// (roughly 4k tokens English) to leave room for the instruction + response.
let MAX_CHARS = 16_000
let truncatedContent = content.count > MAX_CHARS
    ? String(content.prefix(MAX_CHARS)) + "\n\n[...truncated: document continues past this point...]"
    : content

let prompt: String
switch mode {
case "summarize":
    prompt = """
    Summarize the following document in 3-5 clear bullet points. Focus on \
    the key facts, actors, and decisions. Keep it concrete.

    Document:
    \(truncatedContent)
    """
case "qa":
    guard let question = extraArg else { emit("qa requires a question arg", 2) }
    prompt = """
    Answer this question using ONLY information from the document below. \
    If the document doesn't contain the answer, say so clearly. Be concise.

    Question: \(question)

    Document:
    \(truncatedContent)
    """
case "rewrite":
    let style = extraArg ?? "clearer"
    prompt = """
    Rewrite the following text to be \(style). Preserve the meaning \
    exactly. Return only the rewritten text.

    Text:
    \(truncatedContent)
    """
default:
    emit("unknown mode: \(mode) (use summarize | qa | rewrite)", 2)
}

Task {
    do {
        let session = LanguageModelSession()
        let response = try await session.respond(to: prompt)
        let output: [String: Any] = ["ok": true, "text": response.content]
        let data = try JSONSerialization.data(withJSONObject: output, options: [])
        FileHandle.standardOutput.write(data)
        exit(0)
    } catch {
        FileHandle.standardError.write("model error: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(4)
    }
}

// Keep the runloop alive until the Task completes.
RunLoop.main.run()
