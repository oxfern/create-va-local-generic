import { describe, expect, test } from 'bun:test';
import { decodePcm, encodePcm, MonoResampler, PcmPlayer } from './audio';
import { TurnGate } from './turn-state';

describe('browser PCM audio', () => {
  test('44.1 kHz capture keeps the same samples across arbitrary worklet boundaries', () => {
    const input = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 44100));
    const whole = new MonoResampler(44100).process(input);
    const streaming = new MonoResampler(44100);
    const chunks: number[] = [];
    for (let start = 0; start < input.length; start += 2048) chunks.push(...streaming.process(input.subarray(start, start + 2048)));
    expect(whole.length).toBe(16000);
    expect(chunks.length).toBe(whole.length);
    let maximumError = 0;
    for (let i = 0; i < chunks.length; i++) maximumError = Math.max(maximumError, Math.abs(chunks[i] - whole[i]));
    expect(maximumError).toBeLessThan(0.00001);
    // A 440 Hz input must retain its pitch at the 16 kHz wire rate.
    expect(whole[100]).toBeCloseTo(Math.sin(2 * Math.PI * 440 * 100 / 16000), 3);
  });

  test('the wire uses little-endian Float32 and rejects incomplete audio samples', () => {
    const bytes = encodePcm(new Float32Array([0.5, -1]));
    expect([...new Uint8Array(bytes)]).toEqual([0, 0, 0, 63, 0, 0, 128, 191]);
    expect([...decodePcm(btoa(String.fromCharCode(...new Uint8Array(bytes))))]).toEqual([0.5, -1]);
    expect(() => decodePcm(btoa('abc'))).toThrow('Invalid PCM');
  });

  test('interrupt cancels all queued playback and the next reply starts immediately', () => {
    const starts: number[] = [];
    let stops = 0;
    const fakeContext = {
      currentTime: 10, destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: () => {} }),
      createBufferSource: () => ({ connect: () => {}, disconnect: () => {}, start: (at: number) => starts.push(at), stop: () => { stops++; }, onended: null, buffer: null }),
    } as unknown as AudioContext;
    const player = new PcmPlayer(fakeContext, 2);
    player.play(new Float32Array(24000), 24000);
    player.play(new Float32Array(12000), 24000);
    expect(player.active).toBe(true);
    expect(() => player.play(new Float32Array(24000), 24000)).toThrow('faster than');
    player.stop();
    expect(stops).toBe(2);
    expect(player.active).toBe(false);
    player.play(new Float32Array(2400), 24000);
    expect(starts).toEqual([10.025, 11.025, 10.025]);
  });

  test('hands-free remains blocked until scheduled playback drains and its echo tail expires', () => {
    const ended: Array<() => void> = [];
    let clock = 10;
    const fakeContext = {
      get currentTime() { return clock; }, destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: () => {} }),
      createBufferSource: () => {
        const source = { connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {}, onended: null as (() => void) | null, buffer: null };
        ended.push(() => source.onended?.());
        return source;
      },
    } as unknown as AudioContext;
    const player = new PcmPlayer(fakeContext);
    player.play(new Float32Array(24000), 24000);
    player.play(new Float32Array(24000), 24000);
    // Receiving audio_end changes server state but does not end browser source nodes.
    expect(player.blocksHandsfree).toBe(true);
    clock = 11.025; ended[0]();
    expect(player.blocksHandsfree).toBe(true);
    clock = 12.025; ended[1]();
    expect(player.active).toBe(false);
    expect(player.blocksHandsfree).toBe(true);
    clock += 0.36;
    expect(player.blocksHandsfree).toBe(false);
    player.play(new Float32Array(24000), 24000);
    player.stop();
    expect(player.blocksHandsfree).toBe(true);
    clock += 0.36;
    expect(player.blocksHandsfree).toBe(false);
  });

  test('a stopped unacknowledged turn and its stale audio never replace the next voice turn', () => {
    const gate = new TurnGate();
    gate.start(); gate.cancel(); gate.start();
    expect(gate.accept({ type: 'status', state: 'listening', turnId: 1 })).toBe(false);
    expect(gate.accept({ type: 'audio', turnId: 1 })).toBe(false);
    expect(gate.accept({ type: 'status', state: 'listening', turnId: 3 })).toBe(true);
    expect(gate.accept({ type: 'interrupted', turnId: 1 })).toBe(false);
    expect(gate.accept({ type: 'audio', turnId: 3 })).toBe(true);
    gate.cancel();
    expect(gate.accept({ type: 'audio', turnId: 3 })).toBe(false);
    expect(gate.accept({ type: 'status', state: 'idle', turnId: 4 })).toBe(false);
    expect(gate.accept({ type: 'audio' })).toBe(false);
  });
});
