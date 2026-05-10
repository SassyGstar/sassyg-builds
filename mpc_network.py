"""
Multiparty computation network layer.

Handles authenticated TLS connections between parties in a semi-honest MPC protocol.
Party identities and addresses are loaded from network_config.json.
"""

import asyncio
import json
import ssl
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class PartyInfo:
    id: int
    host: str
    port: int
    name: str


@dataclass
class SecuritySettings:
    protocol: str
    use_tls: bool
    ca_cert_path: str


class NetworkConfig:
    def __init__(self, config_path: str = "network_config.json"):
        with open(config_path) as f:
            raw = json.load(f)
        self.myself: int = raw["myself"]
        self.parties: list[PartyInfo] = [PartyInfo(**p) for p in raw["parties"]]
        self.security = SecuritySettings(**raw["security_settings"])

    @property
    def my_party(self) -> PartyInfo:
        return self.parties[self.myself]

    def peer_parties(self) -> list[PartyInfo]:
        return [p for p in self.parties if p.id != self.myself]


class MPCChannel:
    """Bidirectional message channel to a single peer party."""

    def __init__(self, party: PartyInfo, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.party = party
        self._reader = reader
        self._writer = writer

    async def send(self, data: bytes) -> None:
        header = struct.pack(">I", len(data))
        self._writer.write(header + data)
        await self._writer.drain()

    async def recv(self) -> bytes:
        header = await self._reader.readexactly(4)
        (length,) = struct.unpack(">I", header)
        return await self._reader.readexactly(length)

    async def close(self) -> None:
        self._writer.close()
        await self._writer.wait_closed()


class MPCNetwork:
    """
    Manages the full set of peer connections for this party.

    Connection protocol: parties with a lower id act as servers; higher-id parties
    connect as clients. This ensures exactly one connection per pair with no races.
    """

    def __init__(self, config: NetworkConfig):
        self.config = config
        self.channels: dict[int, MPCChannel] = {}
        self._server: Optional[asyncio.Server] = None
        self._pending: dict[int, asyncio.Future] = {}

    def _make_ssl_context(self, server_side: bool) -> Optional[ssl.SSLContext]:
        if not self.config.security.use_tls:
            return None
        purpose = ssl.Purpose.CLIENT_AUTH if server_side else ssl.Purpose.SERVER_AUTH
        ctx = ssl.create_default_context(purpose, cafile=self.config.security.ca_cert_path)
        if server_side:
            ctx.verify_mode = ssl.CERT_REQUIRED
        return ctx

    async def _handle_incoming(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # First message from connecting party is its id (4-byte big-endian uint)
        raw = await reader.readexactly(4)
        (peer_id,) = struct.unpack(">I", raw)
        peer = next((p for p in self.config.parties if p.id == peer_id), None)
        if peer is None:
            writer.close()
            return
        channel = MPCChannel(peer, reader, writer)
        self.channels[peer_id] = channel
        if peer_id in self._pending:
            self._pending[peer_id].set_result(channel)

    async def _connect_to_peer(self, peer: PartyInfo) -> MPCChannel:
        ssl_ctx = self._make_ssl_context(server_side=False)
        reader, writer = await asyncio.open_connection(peer.host, peer.port, ssl=ssl_ctx)
        # Identify ourselves
        writer.write(struct.pack(">I", self.config.myself))
        await writer.drain()
        channel = MPCChannel(peer, reader, writer)
        self.channels[peer.id] = channel
        return channel

    async def start(self) -> None:
        me = self.config.my_party
        ssl_ctx = self._make_ssl_context(server_side=True)

        self._server = await asyncio.start_server(
            self._handle_incoming, me.host, me.port, ssl=ssl_ctx
        )

        # Pre-register futures for peers that will connect to us (higher id peers)
        for peer in self.config.peer_parties():
            if peer.id > self.config.myself:
                self._pending[peer.id] = asyncio.get_event_loop().create_future()

        # Connect to peers with lower id (they are already listening)
        for peer in self.config.peer_parties():
            if peer.id < self.config.myself:
                await self._connect_to_peer(peer)

        # Wait for higher-id peers to connect to us
        if self._pending:
            await asyncio.gather(*self._pending.values())

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        for channel in self.channels.values():
            await channel.close()
        self.channels.clear()

    async def send(self, party_id: int, data: bytes) -> None:
        await self.channels[party_id].send(data)

    async def recv(self, party_id: int) -> bytes:
        return await self.channels[party_id].recv()

    async def broadcast(self, data: bytes) -> None:
        await asyncio.gather(*(ch.send(data) for ch in self.channels.values()))

    async def gather(self) -> dict[int, bytes]:
        results = await asyncio.gather(
            *(ch.recv() for ch in self.channels.values()),
            return_exceptions=False,
        )
        return {pid: msg for pid, msg in zip(self.channels.keys(), results)}


async def main() -> None:
    config = NetworkConfig()
    net = MPCNetwork(config)
    print(f"Starting {config.my_party.name} (id={config.myself}) on port {config.my_party.port}")
    await net.start()
    print(f"Connected to {len(net.channels)} peer(s): {[config.parties[pid].name for pid in net.channels]}")
    await net.stop()


if __name__ == "__main__":
    asyncio.run(main())
