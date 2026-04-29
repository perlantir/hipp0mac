import Foundation
import OperatorDockPersistence

let paths = try OperatorDockPaths.production()
try paths.createLayout()

let keyManager = PersistenceKeyManager()
_ = try keyManager.loadOrCreateKeys()

print("OperatorDockHelper initialized persistence platform at \(paths.root.path)")
