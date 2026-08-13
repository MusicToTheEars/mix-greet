// Hand the real production .pkpass to Apple's own PassKit parser and print what
// Apple says about it — not what our rig says. PKPass is the same class Wallet
// itself constructs a pass from, so a file it refuses is a file a phone refuses.
import Foundation
import PassKit

let path = CommandLine.arguments[1]
guard let data = FileManager.default.contents(atPath: path) else {
    print("could not read \(path)"); exit(1)
}
do {
    let pass = try PKPass(data: data)
    print("Apple's PassKit ACCEPTED the file.")
    print("  localizedName        : \(pass.localizedName)")
    print("  localizedDescription : \(pass.localizedDescription)")
    print("  organizationName     : \(pass.organizationName)")
    print("  passTypeIdentifier   : \(pass.passTypeIdentifier)")
    print("  serialNumber         : \(pass.serialNumber)")
    print("  passURL              : \(pass.passURL?.absoluteString ?? "-")")
    if #available(macOS 10.12, *) {
        print("  isRemotePass         : \(pass.isRemotePass)")
        print("  deviceName           : \(pass.deviceName)")
    }
    // The barcode Apple itself decided to present for this pass. If Wallet were
    // going to draw nothing, this is where it would say so.
    if #available(macOS 11.0, *) {
        // relevantDate/paymentPass omitted deliberately; barcode is the question.
    }
    let mirror = Mirror(reflecting: pass)
    _ = mirror
    print("  --- what Apple will present as the code ---")
    if let b = pass.value(forKey: "barcode") {
        print("  barcode object       : \(b)")
    } else {
        print("  barcode object       : nil  <-- Wallet would draw no code")
    }
} catch {
    print("Apple's PassKit REJECTED the file: \(error)")
    exit(2)
}

// Build and run:
//   swiftc -O scripts/wallet/pkinspect.swift -o /tmp/pkinspect
//   /tmp/pkinspect path/to/pass.pkpass
//
// Note: PKPass verifies the manifest signature, so this only accepts a pass
// signed by the real Apple-issued certificate. A pass from the test rig, or one
// whose pass.json has been edited, is rejected before any of its contents are
// read — which is why the barcode-format control experiment cannot be run this
// way without the production key.
