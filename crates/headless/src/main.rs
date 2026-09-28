use project_core::{Config, Simulation, digest_bytes};
use serde_json::json;
use std::{
    collections::BTreeMap,
    env, fs,
    path::Path,
    process::{Command, ExitCode},
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let mut values = BTreeMap::new();
    while let Some(key) = args.next() {
        if key == "--help" {
            println!(
                "headless --seed <u64> --ticks <0..1000000> --input <config.json> --output <result.json>"
            );
            return Ok(());
        }
        if !["--seed", "--ticks", "--input", "--output"].contains(&key.as_str()) {
            return Err(format!("unknown option {key}").into());
        }
        let value = args.next().ok_or("missing option value")?;
        if values.insert(key, value).is_some() {
            return Err("duplicate option".into());
        }
    }
    let required = |name: &str| values.get(name).ok_or_else(|| format!("required: {name}"));
    let seed: u64 = required("--seed")?.parse()?;
    let ticks: u64 = required("--ticks")?.parse()?;
    if ticks > 1_000_000 {
        return Err("ticks exceeds finite 1000000 limit".into());
    }
    let input = fs::read(required("--input")?)?;
    let config: Config = serde_json::from_slice(&input)?;
    let configuration_hash = config.digest();
    let mut simulation = Simulation::new(seed, config)?;
    simulation.run(ticks);
    let command_output = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    let result = json!({
        "schemaVersion": 1, "hypothesis": "Identical pinned build, configuration, seed and inputs reproduce the state digest.",
        "codeRevision": command_output("git", &["rev-parse", "HEAD"]),
        "workingTreeDirty": command_output("git", &["status", "--porcelain"]).map(|s| !s.is_empty()),
        "configurationHash": configuration_hash, "inputHash": digest_bytes(&input), "seed": seed, "ticks": ticks,
        "command": env::args().collect::<Vec<_>>(),
        "environment": { "os": env::consts::OS, "arch": env::consts::ARCH, "rust": command_output("rustc", &["--version"]), "coreVersion": env!("CARGO_PKG_VERSION") },
        "results": { "state": simulation.state(), "stateDigest": simulation.digest() },
        "limitations": ["Reproducibility tested for the same pinned build/configuration/seed/inputs; cross-platform bitwise determinism is not asserted.", "Desktop rendering and timing are outside this digest."]
    });
    let output = Path::new(required("--output")?);
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(output, serde_json::to_string_pretty(&result)? + "\n")?;
    println!(
        "{}",
        json!({ "output": output, "stateDigest": simulation.digest(), "ticks": ticks })
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({"error": error.to_string()}));
            ExitCode::FAILURE
        }
    }
}
