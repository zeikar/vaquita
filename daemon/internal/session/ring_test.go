package session

import (
	"bytes"
	"fmt"
	"math/rand/v2"
	"slices"
	"testing"
)

// markList returns the ring's current marks, oldest first.
func (r *Ring) markList() []uint64 {
	out := make([]uint64, r.markLen)
	for i := range out {
		out[i] = r.marks[(r.markHead+i)%maxMarks]
	}
	return out
}

func randomBytes(rng *rand.Rand, n int) []byte {
	p := make([]byte, n)
	for i := range p {
		p[i] = byte(rng.Uint32())
	}
	return p
}

// TestRingRandomAgainstReference checks the ring against a plain []byte of
// everything appended. After every append:
//   - evicted bytes (in OnEvict order) followed by the ring content equal
//     everything appended, so eviction is complete, ordered and happens
//     before the bytes are overwritten;
//   - Start only moves when End-Start would exceed the capacity;
//   - when it moves, Start is the first mark recorded before this append
//     that is >= End-cap; if there is none, it is either this append's own
//     boundary (when that is >= End-cap) or the fallback End-cap. So Start
//     is always 0, an offset passed as a boundary, or the fallback.
func TestRingRandomAgainstReference(t *testing.T) {
	for _, capacity := range []int{4096, 100_000, DefaultRingCap} {
		t.Run(fmt.Sprint(capacity), func(t *testing.T) {
			rng := rand.New(rand.NewPCG(1, uint64(capacity)))
			size := uint64(capacity)
			r := NewRing(capacity)
			var evicted []byte
			r.OnEvict = func(b []byte) { evicted = append(evicted, b...) }
			var all, got []byte
			boundaries := map[uint64]bool{}
			var markCuts, fallbackCuts, largerThanCap int

			for i := range 400 {
				n := 1 + rng.IntN([]int{16, 4 << 10, 200 << 10}[rng.IntN(3)])
				p := randomBytes(rng, n)
				if n > capacity {
					largerThanCap++
				}
				// Every other run of 50 appends has no boundaries at all, which
				// forces fallback cuts even at the default capacity.
				boundary := -1
				if i/50%2 == 0 && rng.IntN(4) > 0 {
					boundary = rng.IntN(n + 1)
				}
				off := uint64(len(all))
				if boundary >= 0 {
					boundaries[off+uint64(boundary)] = true
				}

				pre := r.markList()
				prevStart := r.Start()
				r.Append(p, boundary)
				all = append(all, p...)
				// The ring must hold its own copy.
				for j := range p {
					p[j] = ^p[j]
				}

				start, end := r.Start(), r.End()
				if end != uint64(len(all)) {
					t.Fatalf("append %d: End = %d, want %d", i, end, len(all))
				}
				if start < prevStart || end-start > size {
					t.Fatalf("append %d: [Start, End) = [%d, %d), previous Start %d", i, start, end, prevStart)
				}
				if uint64(len(evicted)) != start || !bytes.Equal(evicted[prevStart:], all[prevStart:start]) {
					t.Fatalf("append %d: evicted %d bytes, Start %d, or evicted content differs", i, len(evicted), start)
				}
				got = r.CopyRange(start, end, got[:0])
				if !bytes.Equal(got, all[start:]) {
					t.Fatalf("append %d: ring content differs from reference tail", i)
				}
				if r.markLen > maxMarks {
					t.Fatalf("append %d: %d marks", i, r.markLen)
				}
				for _, m := range r.markList() {
					if m < start {
						t.Fatalf("append %d: mark %d below Start %d", i, m, start)
					}
				}

				if end-prevStart <= size {
					if start != prevStart {
						t.Fatalf("append %d: Start moved %d -> %d without need", i, prevStart, start)
					}
					continue
				}
				floor := end - size
				if k := slices.IndexFunc(pre, func(m uint64) bool { return m >= floor }); k >= 0 {
					if start != pre[k] {
						t.Fatalf("append %d: Start = %d, want first mark >= %d: %d", i, start, floor, pre[k])
					}
				} else if own := off + uint64(boundary); start != floor && (boundary < 0 || start != own || own < floor) {
					t.Fatalf("append %d: Start = %d, want fallback %d or own boundary %d", i, start, floor, own)
				}
				if boundaries[start] {
					markCuts++
				} else if start == floor {
					fallbackCuts++
				} else {
					t.Fatalf("append %d: Start %d is neither a boundary nor the fallback %d", i, start, floor)
				}
			}
			if markCuts == 0 || fallbackCuts == 0 || (largerThanCap == 0 && capacity < 200<<10) {
				t.Fatalf("weak coverage: %d mark cuts, %d fallback cuts, %d appends larger than cap", markCuts, fallbackCuts, largerThanCap)
			}
		})
	}
}

func TestRingCutsAtFirstMarkAtOrAfterFloor(t *testing.T) {
	r := NewRing(4096)
	appendN := func(n, boundary int) { r.Append(make([]byte, n), boundary) }

	appendN(2000, 1500) // mark 1500
	appendN(2000, 1000) // mark 3000
	appendN(1000, 500)  // mark 4500, end 5000, floor 904
	if r.Start() != 1500 {
		t.Fatalf("Start = %d, want 1500", r.Start())
	}
	appendN(2000, -1) // end 7000, floor 2904
	if r.Start() != 3000 {
		t.Fatalf("Start = %d, want 3000", r.Start())
	}
	appendN(3000, -1) // end 10000, floor 5904; mark 4500 is too early
	if r.Start() != 5904 {
		t.Fatalf("Start = %d, want fallback 5904", r.Start())
	}

	r = NewRing(4096)
	appendN(100, 50)   // mark 50
	appendN(100, 50)   // 150 is within markGap of 50 and is not recorded
	appendN(1000, 874) // mark 1074, exactly markGap after 50
	appendN(2996, -1)  // end 4196, floor 100
	if r.Start() != 1074 {
		t.Fatalf("Start = %d, want 1074 (150 must be skipped, 1074 recorded)", r.Start())
	}
}

func TestRingAppendLargerThanCap(t *testing.T) {
	r := NewRing(1000)
	var calls [][]byte
	r.OnEvict = func(b []byte) { calls = append(calls, bytes.Clone(b)) }
	var all []byte
	add := func(p []byte, boundary int) {
		r.Append(p, boundary)
		all = append(all, p...)
	}

	add(bytes.Repeat([]byte("a"), 600), -1)
	add(bytes.Repeat([]byte("b"), 600), -1) // Start 200; content wraps in buf
	calls = nil
	big := randomBytes(rand.New(rand.NewPCG(2, 2)), 2500)
	add(big, -1) // end 3700: only the last 1000 bytes of big fit

	if r.Start() != 2700 || r.End() != 3700 {
		t.Fatalf("[Start, End) = [%d, %d), want [2700, 3700)", r.Start(), r.End())
	}
	var lens []int
	for _, c := range calls {
		lens = append(lens, len(c))
	}
	// The wrapped old content comes in two calls, then the head of big.
	if !slices.Equal(lens, []int{800, 200, 1500}) {
		t.Fatalf("OnEvict call lengths = %v, want [800 200 1500]", lens)
	}
	if !bytes.Equal(bytes.Join(calls, nil), all[200:2700]) {
		t.Fatal("evicted bytes differ from what was appended")
	}
	if got := r.CopyRange(2700, 3700, nil); !bytes.Equal(got, big[1500:]) {
		t.Fatal("ring does not hold the tail of the large append")
	}

	// A boundary inside the part that fits becomes Start.
	big2 := randomBytes(rand.New(rand.NewPCG(3, 3)), 2500)
	add(big2, 2000)
	if r.Start() != 3700+2000 {
		t.Fatalf("Start = %d, want %d", r.Start(), 3700+2000)
	}
	if got := r.CopyRange(r.Start(), r.End(), nil); !bytes.Equal(got, big2[2000:]) {
		t.Fatal("ring does not start at the boundary of the large append")
	}
}

// TestRingMarkDequeBounded feeds boundaries as densely as the spacing
// allows. At the default capacity the spacing alone keeps the deque within
// maxMarks; above maxMarks*markGap the cap has to drop marks.
func TestRingMarkDequeBounded(t *testing.T) {
	t.Run("1-byte appends", func(t *testing.T) {
		rng := rand.New(rand.NewPCG(4, 4))
		r := NewRing(DefaultRingCap)
		size := uint64(DefaultRingCap)
		p := []byte{'x'}
		peak := 0
		for range 3 * DefaultRingCap {
			r.Append(p, rng.IntN(2))
			if r.markLen > maxMarks {
				t.Fatalf("End %d: %d marks", r.End(), r.markLen)
			}
			peak = max(peak, r.markLen)
			if r.End() > size {
				// Dense marks keep the cut within about one gap of the floor.
				if span := r.End() - r.Start(); span > size || span < size-2*markGap {
					t.Fatalf("End %d: ring span %d", r.End(), span)
				}
			}
		}
		if peak < maxMarks-1 {
			t.Fatalf("peak mark count %d, the bound was never approached", peak)
		}
	})
	t.Run("capacity above maxMarks*markGap", func(t *testing.T) {
		r := NewRing(4 * maxMarks * markGap)
		p := make([]byte, markGap)
		for range 3 * 4 * maxMarks {
			r.Append(p, markGap) // every multiple of markGap is a boundary
			if r.markLen > maxMarks {
				t.Fatalf("End %d: %d marks", r.End(), r.markLen)
			}
			if r.Start()%markGap != 0 {
				t.Fatalf("End %d: Start %d is not a boundary", r.End(), r.Start())
			}
		}
	})
}

func TestRingCopyRangeAcrossWrap(t *testing.T) {
	r := NewRing(10)
	r.Append([]byte("0123456789"), -1)
	r.Append([]byte("abcd"), -1) // offsets 10..13 wrap to buf[0:4]
	if r.Start() != 4 || r.End() != 14 {
		t.Fatalf("[Start, End) = [%d, %d), want [4, 14)", r.Start(), r.End())
	}
	got := r.CopyRange(8, 12, []byte(">"))
	if string(got) != ">89ab" {
		t.Fatalf("CopyRange(8, 12) = %q, want %q", got, ">89ab")
	}
	if all := r.CopyRange(4, 14, nil); string(all) != "456789abcd" {
		t.Fatalf("CopyRange(4, 14) = %q", all)
	}
	if empty := r.CopyRange(14, 14, nil); len(empty) != 0 {
		t.Fatalf("CopyRange(14, 14) = %q", empty)
	}

	r.Append([]byte("WXYZ"), -1)
	if string(got) != ">89ab" {
		t.Fatalf("earlier copy changed to %q after overwrite", got)
	}

	for _, rg := range [][2]uint64{{7, 9}, {8, 19}, {12, 10}} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("CopyRange(%d, %d) on [8, 18) did not panic", rg[0], rg[1])
				}
			}()
			r.CopyRange(rg[0], rg[1], nil)
		}()
	}
}
