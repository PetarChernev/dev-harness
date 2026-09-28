use project_core::{Config, Simulation};

#[test]
fn pinned_neutral_experiment_matches_baseline() {
    let config: Config =
        serde_json::from_str(include_str!("../../../experiments/example.json")).unwrap();
    let mut simulation = Simulation::new(42, config).unwrap();
    simulation.run(120);
    assert_eq!(simulation.state().tick, 120);
    assert_eq!(simulation.state().bodies.len(), 16);
    assert_eq!(
        simulation.digest(),
        "a0e4a7d818ae130b1c9130a8c8d1635c5358ebd7f155c41853abf61084b247c9"
    );
}
