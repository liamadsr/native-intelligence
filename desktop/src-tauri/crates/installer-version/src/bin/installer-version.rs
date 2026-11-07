//! `installer-version <setup.exe> <X.Y.Z>`: exits 0 when the app's update
//! check reads exactly X.Y.Z from the installer (the Windows workflow runs it
//! on every installer it builds).

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(expected)) = (args.next(), args.next()) else {
        eprintln!("usage: installer-version <setup.exe> <X.Y.Z>");
        std::process::exit(2);
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(2);
    });
    match installer_version::installer_version(&bytes) {
        Ok(v) if v == expected => println!("{path}: {v}"),
        Ok(v) => {
            eprintln!("{path}: the installer says {v}, not {expected}");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("{path}: {e}");
            std::process::exit(1);
        }
    }
}
