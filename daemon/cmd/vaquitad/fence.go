package main

// Fence decides which bytes typed into attach's terminal reach the session.
//
// When attach writes replayed output, the terminal answers the queries in it
// (DA1, cursor position reports, OSC colour queries and so on) by typing the
// replies into attach's stdin. Those queries were answered when they were
// live, so the replies must not reach the session: they would turn up as
// garbage such as ^[[?1;2c in its input line. Terminals answer in order, so
// after the replay attach writes a DA1 query of its own, the fence, and
// discards its input until the reply to it: whatever the replay drew comes
// before that.
//
// DA1 replies carry no id, and replayed output holds DA1 queries of its own
// (agents send them at startup), so the fence counts. queries is every plain
// DA1 written to the terminal, the fence included, and replies every DA1
// reply read back, with the gate open or closed. The gate opens once replies
// reaches expected, the count up to and including the fence. The totals
// cover the whole attachment and are never reset, so a reply still on its
// way from an earlier generation is accounted for and cannot open a later
// fence early.
//
// While the gate is open everything passes, DA1 replies included: an attach
// that may write to the session is its one responder, and those replies
// answer the session's live queries.
//
// A Fence is not safe for concurrent use.
type Fence struct {
	queries  uint64
	replies  uint64
	expected uint64 // 0 while no fence has been written in this generation
	open     bool
	reply    replyState // progress through a reply, which may span reads
}

// replyState follows a DA1 reply, ESC [ ? Ps;...;Ps c.
type replyState uint8

const (
	replyNone   replyState = iota
	replyEsc               // ESC
	replyCSI               // ESC [
	replyParams            // ESC [ ?, then digits and ';'
)

// NewFence returns a fence with the gate closed and no fence query
// written.
func NewFence() *Fence { return &Fence{} }

// Begin closes the gate before the first byte of a generation is written.
// The totals carry on.
func (f *Fence) Begin() {
	f.open = false
	f.expected = 0
}

// Query counts a plain DA1 query written to the terminal.
func (f *Fence) Query() { f.queries++ }

// Register counts the fence query and makes its reply the one that opens
// the gate. It must be called immediately before the fence query is
// written, so that expected covers exactly the queries written before it.
func (f *Fence) Register() {
	f.queries++
	f.expected = f.queries
}

// Open reports whether the gate is open.
func (f *Fence) Open() bool { return f.open }

// Pending reports whether the terminal still owes replies to DA1 queries it
// has been sent.
func (f *Fence) Pending() bool { return f.replies < f.queries }

// Filter counts the DA1 replies in p, a read from the terminal, and returns
// what may reach the session: all of p while the gate is open, nothing while
// it is closed, and the bytes after the reply that opens it.
func (f *Fence) Filter(p []byte) []byte {
	start := 0
	for i, b := range p {
		if !f.step(b) {
			continue
		}
		f.replies++
		if !f.open && f.expected > 0 && f.replies >= f.expected {
			f.open = true
			start = i + 1
		}
	}
	if !f.open {
		return nil
	}
	return p[start:]
}

// step advances the reply parser by b and reports whether b ended a reply.
func (f *Fence) step(b byte) bool {
	switch {
	case b == 0x1b:
		f.reply = replyEsc
	case f.reply == replyEsc && b == '[':
		f.reply = replyCSI
	case f.reply == replyCSI && b == '?':
		f.reply = replyParams
	case f.reply == replyParams && (b >= '0' && b <= '9' || b == ';'):
	case f.reply == replyParams && b == 'c':
		f.reply = replyNone
		return true
	default:
		f.reply = replyNone
	}
	return false
}
