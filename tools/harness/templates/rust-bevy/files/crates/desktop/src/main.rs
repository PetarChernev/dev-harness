use bevy::{
    app::AppExit,
    prelude::*,
    render::view::screenshot::{Screenshot, save_to_disk},
    window::PresentMode,
    winit::WinitSettings,
};
use project_core::{Config, Simulation};
use std::{
    env, fs,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Resource)]
struct SharedSimulation(Simulation);
#[derive(Component)]
struct Visual(u32);
#[derive(Resource)]
struct Smoke {
    ticks: Option<u64>,
    screenshot: Option<PathBuf>,
    requested: bool,
    final_frame: Option<u64>,
    frames: u64,
    started: Instant,
}

fn main() -> AppExit {
    let mut seed = 42;
    let mut ticks = None;
    let mut input = None;
    let mut screenshot = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        if flag == "--help" {
            println!(
                "desktop [--seed <u64>] [--input <config.json>] [--ticks <1..1000000>] [--screenshot <file.png>]"
            );
            return AppExit::Success;
        }
        let value = args.next().expect("option requires value");
        match flag.as_str() {
            "--seed" => seed = value.parse().expect("u64 seed"),
            "--ticks" => {
                let count = value.parse::<u64>().expect("u64 ticks");
                assert!((1..=1_000_000).contains(&count));
                ticks = Some(count);
            }
            "--input" => input = Some(value),
            "--screenshot" => screenshot = Some(PathBuf::from(value)),
            _ => panic!("unknown option {flag}"),
        }
    }
    if let Some(path) = &screenshot {
        assert!(ticks.is_some(), "screenshot requires finite --ticks");
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).expect("screenshot output directory");
        }
    }
    let config: Config = input
        .map(|p| {
            serde_json::from_slice(&fs::read(p).expect("input file")).expect("valid config JSON")
        })
        .unwrap_or_default();
    let simulation = Simulation::new(seed, config).expect("valid simulation configuration");
    App::new()
        .insert_resource(WinitSettings::continuous())
        .insert_resource(SharedSimulation(simulation))
        .insert_resource(Smoke {
            ticks,
            screenshot,
            requested: false,
            final_frame: None,
            frames: 0,
            started: Instant::now(),
        })
        .insert_resource(ClearColor(Color::srgb(0.12, 0.12, 0.12)))
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "Neutral motion sample".into(),
                resolution: (720, 720).into(),
                present_mode: if ticks.is_some() {
                    PresentMode::AutoNoVsync
                } else {
                    PresentMode::AutoVsync
                },
                ..default()
            }),
            ..default()
        }))
        .add_systems(Startup, setup)
        .add_systems(Update, (advance, visualize, finish).chain())
        .run()
}

fn setup(
    mut commands: Commands,
    simulation: Res<SharedSimulation>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<ColorMaterial>>,
) {
    commands.spawn(Camera2d);
    let mesh = meshes.add(Rectangle::new(8.0, 8.0));
    let material = materials.add(Color::srgb(0.8, 0.8, 0.8));
    for body in &simulation.0.state().bodies {
        commands.spawn((
            Visual(body.id),
            Mesh2d(mesh.clone()),
            MeshMaterial2d(material.clone()),
            Transform::default(),
        ));
    }
}

fn advance(mut simulation: ResMut<SharedSimulation>, mut smoke: ResMut<Smoke>) {
    smoke.frames += 1;
    if smoke
        .ticks
        .is_none_or(|ticks| simulation.0.state().tick < ticks)
    {
        simulation.0.step();
    }
}
fn visualize(simulation: Res<SharedSimulation>, mut visuals: Query<(&Visual, &mut Transform)>) {
    let extent = simulation.0.extent() as f32;
    for (visual, mut transform) in &mut visuals {
        let body = &simulation.0.state().bodies[visual.0 as usize];
        transform.translation = Vec3::new(
            (body.x as f32 / extent - 0.5) * 640.0,
            (body.y as f32 / extent - 0.5) * 640.0,
            0.0,
        );
    }
}
fn finish(
    mut commands: Commands,
    simulation: Res<SharedSimulation>,
    mut smoke: ResMut<Smoke>,
    mut exit: MessageWriter<AppExit>,
) {
    if smoke.ticks.is_none() {
        return;
    }
    if smoke.started.elapsed() > Duration::from_secs(60) {
        eprintln!(
            "graphical smoke timed out: ticks={}, frames={}, screenshot_requested={}",
            simulation.0.state().tick,
            smoke.frames,
            smoke.requested
        );
        exit.write(AppExit::error());
        return;
    }
    if simulation.0.state().tick < smoke.ticks.unwrap() {
        return;
    }
    let frames = smoke.frames;
    let final_frame = *smoke.final_frame.get_or_insert(frames);
    if smoke.frames < final_frame + 3 {
        return;
    }
    if let Some(path) = smoke.screenshot.clone() {
        if !smoke.requested {
            commands
                .spawn(Screenshot::primary_window())
                .observe(save_to_disk(path));
            smoke.requested = true;
            return;
        }
        if !path.exists() {
            return;
        }
    }
    println!(
        "{}",
        serde_json::json!({"ticks": simulation.0.state().tick, "stateDigest": simulation.0.digest(), "graphical": "rendered", "screenshot": smoke.screenshot})
    );
    exit.write(AppExit::Success);
}
