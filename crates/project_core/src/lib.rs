//! Renderer-independent seeded motion, driven only by explicit integer ticks.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub count: u32,
    pub extent: i64,
    pub speed: i64,
    #[serde(default)]
    pub commands: Vec<TimedCommand>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            count: 16,
            extent: 100_000,
            speed: 100,
            commands: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimedCommand {
    /// Commands at tick N are applied in input order before motion for N.
    pub tick: u64,
    pub command: Command,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    SetVelocity { id: u32, vx: i64, vy: i64 },
    Pause { value: bool },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Body {
    pub id: u32,
    pub x: i64,
    pub y: i64,
    pub vx: i64,
    pub vy: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct State {
    pub tick: u64,
    pub paused: bool,
    pub bodies: Vec<Body>,
}

pub struct Simulation {
    config: Config,
    state: State,
}

/// SplitMix64; explicit wrapping arithmetic, no thread-local randomness.
fn next_random(value: &mut u64) -> u64 {
    *value = value.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = *value;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=100_000).contains(&self.count)
            || !(1..=1_000_000).contains(&self.extent)
            || !(0..=self.extent).contains(&self.speed)
        {
            return Err("count must be 1..100000, extent 1..1000000, speed 0..extent".into());
        }
        for input in &self.commands {
            if let Command::SetVelocity { id, vx, vy } = input.command
                && (id >= self.count
                    || vx.unsigned_abs() > 1_000_000
                    || vy.unsigned_abs() > 1_000_000)
            {
                return Err("invalid entity ID or velocity outside +/-1000000".into());
            }
        }
        Ok(())
    }
    pub fn digest(&self) -> String {
        digest_bytes(&serde_json::to_vec(self).expect("config serialization"))
    }
}

impl Simulation {
    pub fn new(seed: u64, config: Config) -> Result<Self, String> {
        config.validate()?;
        let mut random = seed;
        let bodies = (0..config.count)
            .map(|id| Body {
                id,
                x: (next_random(&mut random) % config.extent as u64) as i64,
                y: (next_random(&mut random) % config.extent as u64) as i64,
                vx: (next_random(&mut random) % (2 * config.speed + 1) as u64) as i64
                    - config.speed,
                vy: (next_random(&mut random) % (2 * config.speed + 1) as u64) as i64
                    - config.speed,
            })
            .collect();
        Ok(Self {
            config,
            state: State {
                tick: 0,
                paused: false,
                bodies,
            },
        })
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    pub fn extent(&self) -> i64 {
        self.config.extent
    }
    pub fn step(&mut self) {
        for input in self
            .config
            .commands
            .iter()
            .filter(|c| c.tick == self.state.tick)
        {
            match input.command {
                Command::Pause { value } => self.state.paused = value,
                Command::SetVelocity { id, vx, vy } => {
                    let body = &mut self.state.bodies[id as usize];
                    body.vx = vx;
                    body.vy = vy;
                }
            }
        }
        if !self.state.paused {
            for body in &mut self.state.bodies {
                body.x = (body.x + body.vx).rem_euclid(self.config.extent);
                body.y = (body.y + body.vy).rem_euclid(self.config.extent);
            }
        }
        self.state.tick += 1;
    }
    pub fn run(&mut self, ticks: u64) {
        for _ in 0..ticks {
            self.step();
        }
    }
    pub fn digest(&self) -> String {
        digest_bytes(&serde_json::to_vec(&self.state).expect("state serialization"))
    }
}

pub fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_build_seed_and_inputs_replay_identically() {
        let config = Config {
            commands: vec![
                TimedCommand {
                    tick: 30,
                    command: Command::Pause { value: true },
                },
                TimedCommand {
                    tick: 40,
                    command: Command::Pause { value: false },
                },
            ],
            ..Config::default()
        };
        let mut first = Simulation::new(42, config.clone()).unwrap();
        let mut second = Simulation::new(42, config.clone()).unwrap();
        let mut different = Simulation::new(43, config).unwrap();
        first.run(120);
        second.run(120);
        different.run(120);
        assert_eq!(first.state(), second.state());
        assert_eq!(first.digest(), second.digest());
        assert_ne!(first.digest(), different.digest());
    }
    #[test]
    fn commands_apply_before_motion_and_pause_does_not_stop_tick_count() {
        let config = Config {
            count: 1,
            extent: 10,
            speed: 0,
            commands: vec![
                TimedCommand {
                    tick: 0,
                    command: Command::SetVelocity {
                        id: 0,
                        vx: 11,
                        vy: -11,
                    },
                },
                TimedCommand {
                    tick: 1,
                    command: Command::Pause { value: true },
                },
            ],
        };
        let mut simulation = Simulation::new(0, config).unwrap();
        let before = simulation.state().bodies[0].clone();
        simulation.step();
        assert_eq!(simulation.state().bodies[0].x, (before.x + 11) % 10);
        assert_eq!(
            simulation.state().bodies[0].y,
            (before.y - 11).rem_euclid(10)
        );
        let after = simulation.state().bodies.clone();
        simulation.run(5);
        assert_eq!(simulation.state().tick, 6);
        assert_eq!(simulation.state().bodies, after);
    }
    #[test]
    fn invalid_input_is_rejected_before_execution() {
        assert!(
            Simulation::new(
                1,
                Config {
                    extent: 0,
                    ..Config::default()
                }
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Config>(r#"{"count":1,"extent":10,"speed":1,"unknown":true}"#)
                .is_err()
        );
        assert!(
            Simulation::new(
                1,
                Config {
                    commands: vec![TimedCommand {
                        tick: 0,
                        command: Command::SetVelocity {
                            id: 1000,
                            vx: 0,
                            vy: 0
                        }
                    }],
                    ..Config::default()
                }
            )
            .is_err()
        );
    }
}
