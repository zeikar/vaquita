package session

import "fmt"

// DefaultRingCap is how much recent output each session keeps for replay.
const DefaultRingCap = 1 << 20

const (
	// markGap trades eviction precision for deque size: with dense
	// boundaries a cut lands at most about one gap past the point capacity
	// requires.
	markGap = 1 << 10
	// maxMarks caps the deque's memory; it is what markGap spacing over
	// DefaultRingCap needs.
	maxMarks = 1 << 10
)

// Ring keeps the most recent output of a session, addressed by monotonic
// byte offsets: offset o lives at buf[o%len(buf)] while Start() <= o < End().
//
// Evictions move Start to a cut boundary recorded by Append, so a replay from
// Start never begins inside an escape sequence or a UTF-8 character. Only
// when no recorded boundary is late enough does Start fall back to exactly
// End()-capacity, because memory must stay bounded even for output that never
// returns to ground state.
//
// A Ring is not safe for concurrent use; the session lock guards it.
type Ring struct {
	buf        []byte
	start, end uint64

	// marks is a circular deque of recorded cut boundaries, ascending and
	// never below start.
	marks    [maxMarks]uint64
	markHead int
	markLen  int

	// OnEvict receives the evicted bytes in offset order, possibly split over
	// several calls, before they are overwritten. The slice is only valid
	// during the call and must not be modified; OnEvict must not call back
	// into the Ring.
	OnEvict func([]byte)
}

// NewRing returns an empty ring holding at most capacity bytes.
func NewRing(capacity int) *Ring {
	if capacity <= 0 {
		panic(fmt.Sprintf("ring: capacity %d must be positive", capacity))
	}
	return &Ring{buf: make([]byte, capacity)}
}

// Start is the offset of the oldest byte still in the ring.
func (r *Ring) Start() uint64 { return r.start }

// End is the offset one past the newest byte, i.e. the total ever appended.
func (r *Ring) End() uint64 { return r.end }

// Append copies p into the ring. boundary is the last cut boundary within p
// as an index in [0, len(p)], or -1 when p contains none.
func (r *Ring) Append(p []byte, boundary int) {
	if boundary > len(p) {
		// A mark past End would let a later cut put start beyond end.
		panic(fmt.Sprintf("ring: boundary %d beyond append of %d bytes", boundary, len(p)))
	}
	off := r.end
	r.end += uint64(len(p))
	if boundary >= 0 {
		r.addMark(off + uint64(boundary))
	}
	size := uint64(len(r.buf))
	if r.end-r.start > size {
		r.evict(r.cutPoint(r.end-size), p, off)
	}
	if r.start > off {
		// The head of p was evicted without ever entering buf.
		p = p[r.start-off:]
		off = r.start
	}
	n := copy(r.buf[off%size:], p)
	copy(r.buf, p[n:])
}

// CopyRange appends the bytes in [from, to) to dst and returns the extended
// slice. It panics unless Start() <= from <= to <= End(): callers check
// Start under the same lock, so a stale range is a bug, not a runtime
// condition.
func (r *Ring) CopyRange(from, to uint64, dst []byte) []byte {
	if from < r.start || to > r.end || from > to {
		panic(fmt.Sprintf("session: ring range [%d, %d) outside [%d, %d)", from, to, r.start, r.end))
	}
	a, b := r.view(from, to)
	return append(append(dst, a...), b...)
}

// view returns [from, to) as up to two slices of buf, split where it wraps.
func (r *Ring) view(from, to uint64) (a, b []byte) {
	size := uint64(len(r.buf))
	i := from % size
	j := i + (to - from)
	if j <= size {
		return r.buf[i:j], nil
	}
	return r.buf[i:], r.buf[:j-size]
}

func (r *Ring) addMark(m uint64) {
	if r.markLen > 0 && m-r.marks[(r.markHead+r.markLen-1)%maxMarks] < markGap {
		return
	}
	if r.markLen == maxMarks {
		// Up to DefaultRingCap the spacing overflows the deque by at most one
		// mark, so dropping the oldest costs at most one more gap of eviction.
		// Larger capacities only ever hold marks for the newest
		// maxMarks*markGap bytes, so their cuts shrink the ring to about that.
		r.markHead = (r.markHead + 1) % maxMarks
		r.markLen--
	}
	r.marks[(r.markHead+r.markLen)%maxMarks] = m
	r.markLen++
}

// cutPoint pops marks up to and including the first one at or after floor
// and returns it, or returns floor when no mark is that late.
func (r *Ring) cutPoint(floor uint64) uint64 {
	for r.markLen > 0 {
		m := r.marks[r.markHead]
		r.markHead = (r.markHead + 1) % maxMarks
		r.markLen--
		if m >= floor {
			return m
		}
	}
	return floor
}

// evict drops [start, to) from the ring. p is the slice being appended at
// offset off; when to > off its head is evicted too and goes to OnEvict
// after everything already in buf.
func (r *Ring) evict(to uint64, p []byte, off uint64) {
	if r.OnEvict != nil {
		a, b := r.view(r.start, min(to, off))
		if len(a) > 0 {
			r.OnEvict(a)
		}
		if len(b) > 0 {
			r.OnEvict(b)
		}
		if to > off {
			r.OnEvict(p[:to-off])
		}
	}
	r.start = to
}
