import SwiftUI
import UIKit

/// BeaTrackFam Rewards — App Clip.
///
/// A tiny, native SwiftUI experience (no React Native, no JavaScript bundle)
/// so the clip stays far under Apple's 15 MB App Clip limit. It mirrors the
/// Rewards home screen — the loyalty pitch, the tier ladder and how to earn —
/// then hands the person to the full app (or the shop). The clip never signs
/// anyone in and never touches the network: no account, no points balance,
/// just the program.
@main
struct BeaTrackFamRewardsClipApp: App {
  var body: some Scene {
    WindowGroup {
      ClipHomeView()
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          // Reserved for a future App Clip invocation URL (associated
          // domain + an App Store Connect App Clip experience). Until an
          // associated domain is configured this never fires — the clip
          // simply opens on its home content.
          _ = activity.webpageURL
        }
    }
  }
}

private struct ClipHomeView: View {
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        // Brand header — same words as the app's auth gate.
        VStack(alignment: .leading, spacing: 6) {
          Text("BEATRACKFAM")
            .font(.system(size: 28, weight: .heavy))
            .tracking(6)
            .foregroundColor(.white)
          Text("REWARDS")
            .font(.system(size: 14, weight: .heavy))
            .tracking(10)
            .foregroundColor(.gray)
          Text("Loyalty above all.")
            .font(.system(size: 15))
            .italic()
            .foregroundColor(Color(white: 0.55))
        }
        .padding(.top, 12)

        // Points pitch — mirrors the Home tab's shop card.
        VStack(alignment: .center, spacing: 8) {
          Text("BEATRACKFAM.INFO")
            .font(.system(size: 11, weight: .heavy))
            .tracking(3)
            .foregroundColor(.gray)
          Text("Every order earns points.")
            .font(.system(size: 22, weight: .heavy))
            .foregroundColor(.white)
            .multilineTextAlignment(.center)
          Text("25 pts per order — from the maker of BeaTrackFam.")
            .font(.system(size: 14))
            .foregroundColor(Color(white: 0.67))
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .padding(.horizontal, 16)
        .background(Color(white: 0.07))
        .cornerRadius(14)
        .overlay(
          RoundedRectangle(cornerRadius: 14)
            .stroke(Color(white: 0.17), lineWidth: 1)
        )

        // Tier ladder — same tiers and thresholds as the full app.
        VStack(alignment: .leading, spacing: 12) {
          Text("YOUR TIERS")
            .font(.system(size: 12, weight: .bold))
            .tracking(3)
            .foregroundColor(.gray)
          TierRow(name: "Fam", points: "0 pts", note: "Welcome to the Fam")
          TierRow(name: "Loyal", points: "500 pts", note: "Keep showing up")
          TierRow(name: "Ride or Die", points: "1,500 pts", note: "Loyalty above all")
        }

        // How to earn — same actions as the Earn tab.
        VStack(alignment: .leading, spacing: 12) {
          Text("HOW TO EARN")
            .font(.system(size: 12, weight: .bold))
            .tracking(3)
            .foregroundColor(.gray)
          EarnRow(points: "+25", text: "Shop at beatrackfam.info — per order")
          EarnRow(points: "+100", text: "Refer a friend who joins the Fam")
          EarnRow(points: "+50", text: "Birthday bonus, every year")
        }

        // Handoff to the full app.
        VStack(spacing: 12) {
          Button(action: openFullApp) {
            Text("GET THE FULL APP")
              .font(.system(size: 14, weight: .heavy))
              .tracking(2)
              .foregroundColor(.black)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 14)
              .background(Color.white)
              .cornerRadius(14)
          }
          Button(action: openShop) {
            Text("SHOP BEATRACKFAM.INFO")
              .font(.system(size: 14, weight: .heavy))
              .tracking(2)
              .foregroundColor(.white)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 14)
              .background(Color(white: 0.07))
              .cornerRadius(14)
              .overlay(
                RoundedRectangle(cornerRadius: 14)
                  .stroke(Color(white: 0.17), lineWidth: 1)
              )
          }
          Text("Points, rewards and your balance live in the full app.")
            .font(.system(size: 12))
            .foregroundColor(.gray)
            .multilineTextAlignment(.center)
        }
        .padding(.top, 4)
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 32)
    }
    .background(Color.black.ignoresSafeArea())
    .preferredColorScheme(.dark)
  }

  /// Opens the full Rewards app if it is installed; otherwise falls back to
  /// an App Store search for it. (Swap in the real App Store link / SKOverlay
  /// once the App Store Connect app record exists.)
  private func openFullApp() {
    if let appURL = URL(string: "beatrackfamrewards://"),
      UIApplication.shared.canOpenURL(appURL)
    {
      UIApplication.shared.open(appURL)
      return
    }
    if let storeURL = URL(string: "https://apps.apple.com/us/search?term=BeaTrackFam%20Rewards") {
      UIApplication.shared.open(storeURL)
    }
  }

  private func openShop() {
    if let shopURL = URL(string: "https://beatrackfam.info") {
      UIApplication.shared.open(shopURL)
    }
  }
}

private struct TierRow: View {
  let name: String
  let points: String
  let note: String

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(name)
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(Color(white: 0.87))
        Text(note)
          .font(.system(size: 12))
          .foregroundColor(.gray)
      }
      Spacer()
      Text(points)
        .font(.system(size: 15, weight: .heavy))
        .foregroundColor(.white)
    }
    .padding(14)
    .background(Color(white: 0.07))
    .cornerRadius(14)
    .overlay(
      RoundedRectangle(cornerRadius: 14)
        .stroke(Color(white: 0.17), lineWidth: 1)
    )
  }
}

private struct EarnRow: View {
  let points: String
  let text: String

  var body: some View {
    HStack(spacing: 12) {
      Text(points)
        .font(.system(size: 15, weight: .heavy))
        .foregroundColor(.white)
        .frame(minWidth: 52, alignment: .leading)
      Text(text)
        .font(.system(size: 14))
        .foregroundColor(Color(white: 0.87))
      Spacer()
    }
    .padding(14)
    .background(Color(white: 0.07))
    .cornerRadius(14)
    .overlay(
      RoundedRectangle(cornerRadius: 14)
        .stroke(Color(white: 0.17), lineWidth: 1)
    )
  }
}
