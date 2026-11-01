"""Reproducible monochrome film texture. No image generation service or source photo edits."""
from pathlib import Path
import random, struct, zlib

def texture(width=1080, height=1920):
    rng = random.Random(0xCE12E9)
    # Fine irregular grains with a very faint 2-pixel clumping layer, never a tiled pattern.
    clumps = [[rng.uniform(-8, 8) for _ in range((width+1)//2)] for _ in range((height+1)//2)]
    data = bytearray()
    for y in range(height):
        data.append(0)
        for x in range(width):
            fine = sum(rng.random() for _ in range(4)) - 2
            data.append(max(0, min(255, round(128 + 68*fine + clumps[y//2][x//2]))))
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind+value))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB',width,height,8,0,0,0,0)) + chunk(b'IDAT',zlib.compress(data,9)) + chunk(b'IEND',b'')

if __name__ == '__main__':
    dest = Path(__file__).resolve().parents[1] / 'tip-alerts/film/grain-v1.png'
    dest.write_bytes(texture())
    print(f'Wrote procedural monochrome texture: {dest.stat().st_size:,} bytes')
