package main

import (
	"strings"
	"testing"
)

func TestKeyScannerDetach(t *testing.T) {
	for _, tc := range []struct {
		name, in, fwd string
		detach        bool
	}{
		{"legacy", "\x1c", "", true},
		{"legacy after typing", "ls\x1crm", "ls", true},
		{"kitty", "\x1b[92;5u", "", true},
		{"kitty press event", "\x1b[92;5:1u", "", true},
		{"kitty repeat event", "\x1b[92;5:2u", "", true},
		{"kitty caps lock", "\x1b[92;69u", "", true},
		{"kitty num lock", "\x1b[92;133u", "", true},
		{"kitty alternate keys", "\x1b[92:124;5u", "", true},
		{"kitty associated text", "\x1b[92;5;28u", "", true},
		{"modifyOtherKeys", "a\x1b[27;5;92~b", "a", true},
		{"kitty release swallowed", "x\x1b[92;5:3uy", "xy", false},
		{"ctrl-shift", "\x1b[92;6u", "\x1b[92;6u", false},
		{"plain backslash", "\x1b[92u", "\x1b[92u", false},
		{"other key", "\x1b[99;5u", "\x1b[99;5u", false},
		{"modifyOtherKeys other key", "\x1b[27;5;93~", "\x1b[27;5;93~", false},
		{"arrow", "\x1b[A\x1b[1;5A", "\x1b[A\x1b[1;5A", false},
		{"DA1 reply", da1Reply, da1Reply, false},
		{"kitty flags reply", "\x1b[?1u", "\x1b[?1u", false},
		{"lone escape", "\x1b", "\x1b", false},
		{"escape bracket", "\x1b[", "\x1b[", false},
		{"alt key", "\x1bx", "\x1bx", false},
		{"control byte inside", "\x1b[92\x1c", "\x1b[92", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var k keyScanner
			fwd, detach := k.scan([]byte(tc.in))
			if string(fwd) != tc.fwd || detach != tc.detach {
				t.Errorf("scan(%q) = %q, %v; want %q, %v", tc.in, fwd, detach, tc.fwd, tc.detach)
			}
		})
	}
}

// A sequence cut off at the end of a read is held back until the next read
// shows what it is.
func TestKeyScannerSplit(t *testing.T) {
	for _, tc := range []struct {
		name         string
		reads, fwd   []string
		detachOnLast bool
	}{
		{"detach", []string{"a\x1b[92;", "5u"}, []string{"a", ""}, true},
		{"detach byte by byte", []string{"\x1b[9", "2", ";", "5", "u"}, []string{"", "", "", "", ""}, true},
		// A bare ESC or ESC [ at the end of a read goes out at once: it is
		// the Escape key (or Alt-[), which programs tell apart by timing.
		{"after ESC [", []string{"\x1b[", "92;5u"}, []string{"\x1b[", "92;5u"}, false},
		{"release", []string{"\x1b[92;5:", "3uz"}, []string{"", "z"}, false},
		{"other key", []string{"\x1b[1;", "5Ab"}, []string{"", "\x1b[1;5Ab"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var k keyScanner
			for i, r := range tc.reads {
				fwd, detach := k.scan([]byte(r))
				last := i == len(tc.reads)-1
				if string(fwd) != tc.fwd[i] || detach != (last && tc.detachOnLast) {
					t.Errorf("read %d %q: got %q, %v; want %q, %v", i, r, fwd, detach, tc.fwd[i], last && tc.detachOnLast)
				}
			}
		})
	}
}

// An overlong sequence is not a key; it is passed on intact.
func TestKeyScannerOverlong(t *testing.T) {
	var k keyScanner
	in := "\x1b[" + strings.Repeat("1;", 40) + "u"
	if fwd, detach := k.scan([]byte(in)); string(fwd) != in || detach {
		t.Errorf("scan = %q, %v", fwd, detach)
	}
}
