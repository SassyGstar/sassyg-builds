"""
Gemini-over-MPC: each party runs a Gemini prompt on its private data locally,
then the parties exchange their outputs via the MPC network so every party ends
up with the full set of responses — without revealing raw inputs to anyone.

Usage (run on each machine, adjusting `myself` in network_config.json):
    export GEMINI_API_KEY=<your-key>
    python gemini_mpc.py --prompt "Summarise the key risk in this dataset:"
"""

import asyncio
import json
import os
import argparse
from dataclasses import dataclass
from typing import Optional

import google.generativeai as genai

from mpc_network import MPCNetwork, NetworkConfig


@dataclass
class GeminiConfig:
    model: str
    api_key_env: str

    @property
    def api_key(self) -> str:
        key = os.environ.get(self.api_key_env)
        if not key:
            raise EnvironmentError(
                f"Set the {self.api_key_env} environment variable before running."
            )
        return key


class GeminiMPCSession:
    """
    Coordinates a single round of Gemini inference across all MPC parties.

    Round structure:
      1. Each party calls Gemini with its private local_input.
      2. The Gemini response is broadcast to all peers over the MPC network.
      3. Each party collects and returns all responses keyed by party name.
    """

    def __init__(self, net: MPCNetwork, cfg: NetworkConfig, gemini_cfg: GeminiConfig):
        self.net = net
        self.cfg = cfg
        self.gemini_cfg = gemini_cfg
        genai.configure(api_key=gemini_cfg.api_key)
        self._model = genai.GenerativeModel(gemini_cfg.model)

    async def run(self, prompt: str, local_input: str) -> dict[str, str]:
        full_prompt = f"{prompt}\n\n{local_input}"
        response = await asyncio.to_thread(
            lambda: self._model.generate_content(full_prompt).text
        )

        payload = json.dumps({
            "party_id": self.cfg.myself,
            "party_name": self.cfg.my_party.name,
            "response": response,
        }).encode()

        await self.net.broadcast(payload)
        peer_msgs = await self.net.gather()

        results: dict[str, str] = {self.cfg.my_party.name: response}
        for raw in peer_msgs.values():
            entry = json.loads(raw.decode())
            results[entry["party_name"]] = entry["response"]

        return results


def load_gemini_config(config_path: str = "network_config.json") -> GeminiConfig:
    with open(config_path) as f:
        raw = json.load(f)
    return GeminiConfig(**raw["gemini"])


async def main(prompt: str, local_input: str) -> None:
    cfg = NetworkConfig()
    gemini_cfg = load_gemini_config()
    net = MPCNetwork(cfg)

    print(f"[{cfg.my_party.name}] Connecting to MPC network…")
    await net.start()
    print(f"[{cfg.my_party.name}] Connected. Running Gemini inference…")

    session = GeminiMPCSession(net, cfg, gemini_cfg)
    results = await session.run(prompt, local_input)

    print(f"\n[{cfg.my_party.name}] All party responses:")
    for name, text in results.items():
        print(f"\n--- {name} ---\n{text}")

    await net.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini inference over MPC network")
    parser.add_argument("--prompt", required=True, help="Shared prompt sent by all parties")
    parser.add_argument("--input", dest="local_input", default="", help="This party's private input")
    args = parser.parse_args()
    asyncio.run(main(args.prompt, args.local_input))
