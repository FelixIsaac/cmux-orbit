import SwiftUI

struct OrbitContainerView: View {
    @AppStorage("cmux_orbit_host_url") private var hostURLString: String = "http://100.64.0.26:4400"
    @State private var reloadToken = UUID()
    @State private var loadError: String? = nil
    @State private var isLoading: Bool = true
    @State private var showHostSheet: Bool = false
    @State private var draftURLString: String = ""

    private let obsidianBg = Color(red: 9/255, green: 10/255, blue: 15/255)
    private let cardBg = Color(red: 18/255, green: 20/255, blue: 30/255)
    private let accentBlue = Color(red: 122/255, green: 162/255, blue: 247/255)

    var body: some View {
        ZStack {
            obsidianBg.ignoresSafeArea()

            if let url = URL(string: hostURLString) {
                OrbitWebView(
                    url: url,
                    reloadToken: reloadToken,
                    isLoading: $isLoading,
                    loadError: $loadError,
                    onOpenHostSettings: {
                        draftURLString = hostURLString
                        showHostSheet = true
                    }
                )
                .ignoresSafeArea(.container, edges: .bottom)
            }

            if let errorMsg = loadError {
                VStack(spacing: 18) {
                    Circle()
                        .fill(Color.orange.opacity(0.18))
                        .frame(width: 64, height: 64)
                        .overlay(
                            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                                .font(.system(size: 26, weight: .semibold))
                                .foregroundColor(.orange)
                        )

                    Text("Cannot Reach Mac Host")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(.white)

                    Text(errorMsg)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)

                    Text("Ensure Tailscale is connected on your iPhone and cmux-orbit is running on \(hostURLString).")
                        .font(.system(size: 14))
                        .foregroundColor(Color(white: 0.72))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)

                    HStack(spacing: 12) {
                        Button(action: {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            loadError = nil
                            reloadToken = UUID()
                        }) {
                            Label("Retry Now", systemImage: "arrow.clockwise")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(.black)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 12)
                                .background(accentBlue)
                                .cornerRadius(12)
                        }

                        Button(action: {
                            draftURLString = hostURLString
                            showHostSheet = true
                        }) {
                            Label("Host URL", systemImage: "slider.horizontal.3")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 12)
                                .background(Color.white.opacity(0.08))
                                .cornerRadius(12)
                        }
                    }
                }
                .padding(24)
                .background(cardBg)
                .cornerRadius(24)
                .overlay(
                    RoundedRectangle(cornerRadius: 24)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .padding(24)
            }
        }
        .sheet(isPresented: $showHostSheet) {
            NavigationStack {
                Form {
                    Section("Mac Tailscale / LAN Endpoint") {
                        TextField("http://100.64.0.26:4400", text: $draftURLString)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .font(.system(.body, design: .monospaced))
                    }
                    Section("Presets") {
                        Button("felixs-helm Tailscale (http://100.64.0.26:4400)") {
                            draftURLString = "http://100.64.0.26:4400"
                        }
                        Button("Localhost Simulator (http://127.0.0.1:4400)") {
                            draftURLString = "http://127.0.0.1:4400"
                        }
                    }
                }
                .navigationTitle("cmux Orbit Host")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showHostSheet = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Connect") {
                            let cleaned = draftURLString.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !cleaned.isEmpty {
                                hostURLString = cleaned
                                loadError = nil
                                reloadToken = UUID()
                            }
                            showHostSheet = false
                        }
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }
}
