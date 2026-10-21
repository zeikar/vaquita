package main

import "testing"

const da1Reply = "\x1b[?1;2c"

// filter feeds each read to f and returns what passed, all reads together.
func filter(f *Fence, reads ...string) string {
	var out []byte
	for _, r := range reads {
		out = append(out, f.Filter([]byte(r))...)
	}
	return string(out)
}

func TestFenceClosedUntilRegistered(t *testing.T) {
	f := NewFence()
	if f.Open() {
		t.Fatal("a new fence is open")
	}
	// A reply arriving before the fence query is written is counted and
	// discarded, and cannot open the gate on its own.
	f.Query()
	if got := filter(f, "typed"+da1Reply+"more"); got != "" {
		t.Errorf("closed fence passed %q", got)
	}
	if f.Open() || f.replies != 1 {
		t.Fatalf("open %v, replies %d; want closed with 1 reply counted", f.Open(), f.replies)
	}
	f.Register()
	if got := filter(f, da1Reply+"after"); got != "after" {
		t.Errorf("passed %q, want only the bytes after the opening reply", got)
	}
	if !f.Open() {
		t.Error("the fence reply did not open the gate")
	}
}

// Replies to queries written before the fence come first and are discarded;
// only the reply to the fence itself opens the gate.
func TestFenceOpensOnTheMatchingReply(t *testing.T) {
	const n = 3
	f := NewFence()
	for range n {
		f.Query()
	}
	f.Register()
	for i := range n {
		if got := filter(f, da1Reply+"x"); got != "" || f.Open() {
			t.Fatalf("reply %d: passed %q, open %v; want it discarded", i+1, got, f.Open())
		}
	}
	if got := filter(f, da1Reply+"hello"); got != "hello" || !f.Open() {
		t.Errorf("reply %d: passed %q, open %v; want the gate open and %q passed", n+1, got, f.Open(), "hello")
	}
}

func TestFenceSplitReplies(t *testing.T) {
	f := NewFence()
	f.Query()
	f.Register()
	// Byte by byte: the first reply is the replay's, the second the fence's.
	var reads []string
	for _, b := range []byte(da1Reply + da1Reply + "ok") {
		reads = append(reads, string(b))
	}
	if got := filter(f, reads...); got != "ok" {
		t.Errorf("passed %q, want %q", got, "ok")
	}
	if f.replies != 2 {
		t.Errorf("replies = %d, want 2", f.replies)
	}
}

// Other answers the terminal gives to replayed queries, such as an OSC 11
// colour report or a cursor position report, are discarded with the rest.
func TestFenceDiscardsOtherResponses(t *testing.T) {
	f := NewFence()
	f.Register()
	got := filter(f, "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b[12;1R", da1Reply, "ls\r")
	if got != "ls\r" {
		t.Errorf("passed %q, want %q", got, "ls\r")
	}
}

// Once open, everything passes, DA1 replies included: they answer the
// session's live queries. They are still counted.
func TestFenceOpenPassesReplies(t *testing.T) {
	f := NewFence()
	f.Register()
	filter(f, da1Reply)
	f.Query()
	in := "a" + da1Reply + "b"
	if got := filter(f, in); got != in {
		t.Errorf("open fence passed %q, want %q", got, in)
	}
	if f.replies != 2 {
		t.Errorf("replies = %d, want 2", f.replies)
	}
}

// A live query counted while the gate was open whose reply is still on its
// way when a new generation begins: the reply is absorbed by the totals and
// does not open the new fence.
func TestFenceInFlightReplyDoesNotOpenLaterFence(t *testing.T) {
	f := NewFence()
	f.Register()
	filter(f, da1Reply)
	f.Query() // live, answered below only after the reset

	f.Begin()
	if f.Open() {
		t.Fatal("Begin left the gate open")
	}
	f.Register()
	if got := filter(f, da1Reply+"early"); got != "" || f.Open() {
		t.Fatalf("passed %q, open %v; the in-flight reply opened the new fence", got, f.Open())
	}
	if got := filter(f, da1Reply+"late"); got != "late" || !f.Open() {
		t.Errorf("passed %q, open %v; want the fence reply to open it", got, f.Open())
	}
}

// After Begin the gate stays closed until the new fence is answered, even
// for a reply that would have satisfied the old one: one still on its way
// from the old generation, arriving during the new replay.
func TestFenceClosedAfterBeginUntilRegistered(t *testing.T) {
	f := NewFence()
	f.Register()
	filter(f, da1Reply)
	f.Query()
	f.Begin()
	if got := filter(f, da1Reply+"x"); got != "" || f.Open() {
		t.Fatalf("passed %q, open %v; want the gate closed until the new fence", got, f.Open())
	}
	f.Register()
	if got := filter(f, da1Reply+"y"); got != "y" {
		t.Errorf("passed %q, want %q", got, "y")
	}
}

// A reply split across Begin is still recognised.
func TestFenceReplySplitAcrossBegin(t *testing.T) {
	f := NewFence()
	f.Register()
	filter(f, da1Reply)
	f.Query()
	half := len(da1Reply) / 2
	if got := filter(f, da1Reply[:half]); got != da1Reply[:half] {
		t.Fatalf("open fence passed %q", got)
	}
	f.Begin()
	f.Register()
	filter(f, da1Reply[half:])
	if f.replies != 2 || f.Open() {
		t.Fatalf("replies %d, open %v; want 2 and closed", f.replies, f.Open())
	}
	if got := filter(f, da1Reply+"z"); got != "z" {
		t.Errorf("passed %q, want %q", got, "z")
	}
}

func TestFenceIgnoresLookalikes(t *testing.T) {
	f := NewFence()
	// A DA2 reply, DECRPM, a kitty keyboard flags reply and an arrow key
	// are not DA1 replies.
	filter(f, "\x1b[>1;10;0c", "\x1b[?2004;1$y", "\x1b[?1u", "\x1b[A")
	if f.replies != 0 {
		t.Errorf("replies = %d, want 0", f.replies)
	}
}
