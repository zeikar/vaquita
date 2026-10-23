package session

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

var trackedModes = []int{1, 7, 9, 25, 47, 1047, 1049, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 2004, 2026}

func feedModes(m *Modes, s string) { NewScanner(m).Scan([]byte(s)) }

func modesFrom(s string) *Modes {
	var m Modes
	feedModes(&m, s)
	return &m
}

func decset(n int, on bool) string {
	if on {
		return fmt.Sprintf("\x1b[?%dh", n)
	}
	return fmt.Sprintf("\x1b[?%dl", n)
}

func keyStackOf(m *Modes, screen int) []int {
	return slices.Clone(m.keys[screen].flags[:m.keys[screen].n])
}

// canonical clears the stack slots above each top, which hold leftovers of
// popped entries, so that equal states compare equal with ==.
func canonical(m Modes) Modes {
	for i := range m.keys {
		clear(m.keys[i].flags[m.keys[i].n:])
	}
	return m
}

func checkSeqs(t *testing.T, m *Modes, prefix, reset string) {
	t.Helper()
	if got := string(m.Prefix()); got != prefix {
		t.Errorf("Prefix = %q, want %q", got, prefix)
	}
	if got := string(m.ResetSeq()); got != reset {
		t.Errorf("ResetSeq = %q, want %q", got, reset)
	}
}

func TestModesDefault(t *testing.T) {
	var m Modes
	if m.Prefix() != nil || m.ResetSeq() != nil {
		t.Fatalf("zero Modes: Prefix %q, ResetSeq %q, want nil", m.Prefix(), m.ResetSeq())
	}
	// Setting the defaults explicitly changes nothing.
	m = *modesFrom("\x1b[?7h\x1b[?25h\x1b[?1l\x1b[?1049l\x1b[?2004l")
	if m != (Modes{}) {
		t.Fatalf("explicit defaults: %+v, want zero", m)
	}
}

func TestModesSetReset(t *testing.T) {
	for _, n := range trackedModes {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			set, reset := decset(n, true), decset(n, false)
			defaultOn := n == 7 || n == 25

			m := modesFrom(set)
			if defaultOn {
				checkSeqs(t, m, "", "")
			} else {
				checkSeqs(t, m, set, reset)
			}

			feedModes(m, reset)
			if defaultOn {
				checkSeqs(t, m, reset, set)
			} else {
				checkSeqs(t, m, "", "")
			}
		})
	}
}

func TestModesSequences(t *testing.T) {
	for _, tc := range []struct {
		name, in, prefix string
	}{
		{"parameter list", "\x1b[?1000;1006h", "\x1b[?1000h\x1b[?1006h"},
		{"parameter list reset", "\x1b[?1;2004;1004h\x1b[?2004;1l", "\x1b[?1004h"},
		{"untracked modes in a list", "\x1b[?12;2004;1015h", "\x1b[?2004h"},
		{"empty parameter in a list", "\x1b[?;2004h", "\x1b[?2004h"},
		{"saturated parameter", "\x1b[?18446744073709553642h", ""},
		{"not private", "\x1b[4h\x1b[2004h", ""},
		{"other private marker", "\x1b[>2004h", ""},
		{"intermediate", "\x1b[?2004$h\x1b[?1049$p", ""},
		{"subparameter", "\x1b[?20:04h", ""},
		{"modifyOtherKeys", "\x1b[>4;2m", ""},
		{"keyboard query", "\x1b[>1u\x1b[?u", "\x1b[>1u"},
		{"restore cursor", "\x1b[>1u\x1b[u", "\x1b[>1u"},
		{"UTF-8 inside CSI", "\x1b[?20\xc3\xa904h", ""},
		{"text and SGR", "a\x1b[1;31mb\x1b[0m\r\n", ""},

		// Mouse tracking and encoding are one setting each; so is the
		// alternate screen.
		{"tracking replaced", "\x1b[?1000h\x1b[?1002h", "\x1b[?1002h"},
		{"tracking off by any reset", "\x1b[?1002h\x1b[?1000l", ""},
		{"tracking list keeps last", "\x1b[?1003;1000h", "\x1b[?1000h"},
		{"encoding replaced", "\x1b[?1006h\x1b[?1005h", "\x1b[?1005h"},
		{"encoding not reset by the other", "\x1b[?1006h\x1b[?1005l", "\x1b[?1006h"},
		{"encoding reset by its own mode", "\x1b[?1005h\x1b[?1006h\x1b[?1006l", ""},
		{"X10 tracking replaced", "\x1b[?9h\x1b[?1000h", "\x1b[?1000h"},
		{"tracking off by X10 reset", "\x1b[?1003h\x1b[?9l", ""},
		{"alternate screen replaced", "\x1b[?1049h\x1b[?47h", "\x1b[?47h"},
		{"alternate screen left by any reset", "\x1b[?1049h\x1b[?47l", ""},
		{"tracking and encoding independent", "\x1b[?1002h\x1b[?1006h\x1b[?1004h", "\x1b[?1004h\x1b[?1002h\x1b[?1006h"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(modesFrom(tc.in).Prefix()); got != tc.prefix {
				t.Errorf("Prefix = %q, want %q", got, tc.prefix)
			}
		})
	}
}

func TestModesKittyStacks(t *testing.T) {
	full := strings.Repeat("\x1b[>1u", maxKeyFlags) + "\x1b[>2u"
	wantFull := append(slices.Repeat([]int{1}, maxKeyFlags-1), 2)
	for _, tc := range []struct {
		name      string
		in        string
		main, alt []int
		onAlt     bool
	}{
		{"push", "\x1b[>1u\x1b[>3u", []int{1, 3}, nil, false},
		{"push without flags", "\x1b[>u", []int{0}, nil, false},
		{"push ignores extra parameters", "\x1b[>5;9u", []int{5}, nil, false},
		{"pop one", "\x1b[>1u\x1b[>3u\x1b[<u", []int{1}, nil, false},
		{"pop zero means one", "\x1b[>1u\x1b[>3u\x1b[<0u", []int{1}, nil, false},
		{"pop n", "\x1b[>1u\x1b[>3u\x1b[>7u\x1b[<2u", []int{1}, nil, false},
		{"pop more than present", "\x1b[>1u\x1b[<5u", nil, nil, false},
		{"pop empty", "\x1b[<u", nil, nil, false},
		{"overflow drops oldest", full, wantFull, nil, false},
		{"pop after overflow", strings.Repeat("\x1b[>1u", maxKeyFlags+2) + "\x1b[<9u", nil, nil, false},
		{"set top", "\x1b[>1u\x1b[>3u\x1b[=4u", []int{1, 4}, nil, false},
		{"set mode 1", "\x1b[>3u\x1b[=4;1u", []int{4}, nil, false},
		{"set mode 2 ors", "\x1b[>3u\x1b[=4;2u", []int{7}, nil, false},
		{"set mode 3 clears", "\x1b[>7u\x1b[=2;3u", []int{5}, nil, false},
		{"set unknown mode", "\x1b[>7u\x1b[=2;4u", []int{7}, nil, false},
		{"set on empty creates an entry", "\x1b[=5u", []int{5}, nil, false},
		{"set or on empty", "\x1b[=5;2u", []int{5}, nil, false},
		{"set then pop restores none", "\x1b[=5u\x1b[<u", nil, nil, false},
		{"alt push leaves main", "\x1b[>1u\x1b[?1049h\x1b[>7u", []int{1}, []int{7}, true},
		{"alt stack kept on main", "\x1b[>1u\x1b[?1049h\x1b[>7u\x1b[?1049l", []int{1}, []int{7}, false},
		{"main pop leaves alt", "\x1b[?1049h\x1b[>7u\x1b[?1049l\x1b[>1u\x1b[<3u", nil, []int{7}, false},
		{"alt pop leaves main", "\x1b[>1u\x1b[?1047h\x1b[>7u\x1b[<u", []int{1}, nil, true},
		{"alt set leaves main", "\x1b[>1u\x1b[?47h\x1b[=6u", []int{1}, []int{6}, true},
		{"stack follows any alt mode", "\x1b[?47h\x1b[>2u\x1b[?1049h\x1b[>3u\x1b[?1047l\x1b[>4u", []int{4}, []int{2, 3}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := modesFrom(tc.in)
			if got := keyStackOf(m, mainScreen); !slices.Equal(got, tc.main) {
				t.Errorf("main stack %v, want %v", got, tc.main)
			}
			if got := keyStackOf(m, altScreen); !slices.Equal(got, tc.alt) {
				t.Errorf("alternate stack %v, want %v", got, tc.alt)
			}
			if onAlt := m.alt != 0; onAlt != tc.onAlt {
				t.Errorf("alternate screen selected: %v, want %v", onAlt, tc.onAlt)
			}
		})
	}
}

// everything sets every kind of state Modes tracks.
const everything = "\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?1004h\x1b[?2004h\x1b[?2026h\x1b[?1003h\x1b[?1006h" +
	"\x1b[>1u\x1b[?1049h\x1b[>7u"

func TestModesRIS(t *testing.T) {
	m := modesFrom(everything + "\x1bc")
	if *m != (Modes{}) {
		t.Fatalf("after RIS: %+v, want zero", *m)
	}
	// RIS is ESC c only; an ESC with an intermediate before c is not RIS.
	if m := modesFrom(everything + "\x1b(c"); *m == (Modes{}) {
		t.Fatal("ESC ( c reset the modes")
	}
}

func TestModesDECSTR(t *testing.T) {
	m := modesFrom(everything + "\x1b[!p")
	checkSeqs(t, m,
		"\x1b[>1u\x1b[?1049h\x1b[>7u\x1b[?2026h\x1b[?1003h\x1b[?1006h",
		"\x1b[<1u\x1b[?1049l\x1b[<1u\x1b[?2026l\x1b[?1003l\x1b[?1006l")

	// Only the parameterless form is DECSTR.
	m = modesFrom("\x1b[?2004h\x1b[1!p\x1b[?!p")
	checkSeqs(t, m, "\x1b[?2004h", "\x1b[?2004l")
}

func TestModesPrefixOrder(t *testing.T) {
	for _, tc := range []struct {
		name, in, prefix, reset string
	}{
		{
			"alternate screen selected",
			"\x1b[?2004h\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>7u\x1b[?25l\x1b[?1000;1003;1006h\x1b[?1h",
			"\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>7u\x1b[?1h\x1b[?25l\x1b[?2004h\x1b[?1003h\x1b[?1006h",
			"\x1b[<1u\x1b[?1049l\x1b[<2u\x1b[?1l\x1b[?25h\x1b[?2004l\x1b[?1003l\x1b[?1006l",
		},
		{
			"inactive alternate stack",
			"\x1b[>1u\x1b[?1049h\x1b[>7u\x1b[?1049l\x1b[?2004h",
			"\x1b[?1049h\x1b[>7u\x1b[?1049l\x1b[>1u\x1b[?2004h",
			"\x1b[?1049h\x1b[<1u\x1b[?1049l\x1b[<1u\x1b[?2004l",
		},
		{
			"alternate screen by 47",
			"\x1b[?47h\x1b[>2u",
			"\x1b[?47h\x1b[>2u",
			"\x1b[<1u\x1b[?47l",
		},
		{
			"alternate screen by 1047 without flags",
			"\x1b[?1047h",
			"\x1b[?1047h",
			"\x1b[?1047l",
		},
		{
			"main stack only",
			"\x1b[>0u\x1b[>31u",
			"\x1b[>0u\x1b[>31u",
			"\x1b[<2u",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checkSeqs(t, modesFrom(tc.in), tc.prefix, tc.reset)
		})
	}
}

func TestModesReleaseSeq(t *testing.T) {
	for _, tc := range []struct {
		name, in, release string
	}{
		{"defaults", "", ""},
		{"only the line editor's modes", "\x1b[?1h\x1b[?2004h", ""},
		{
			"full-screen agent",
			"\x1b[?2004h\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2026h",
			"\x1b[?1049l\x1b[?25h\x1b[?1004l\x1b[?2026l\x1b[?1003l\x1b[?1006l",
		},
		{
			"everything",
			everything,
			"\x1b[<1u\x1b[?1049l\x1b[<1u\x1b[?7h\x1b[?25h\x1b[?1004l\x1b[?2026l\x1b[?1003l\x1b[?1006l",
		},
		{
			"inactive alternate stack",
			"\x1b[>1u\x1b[?1049h\x1b[>7u\x1b[?1049l",
			"\x1b[?1049h\x1b[<1u\x1b[?1049l\x1b[<1u",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := modesFrom(tc.in).ReleaseSeq()
			if string(got) != tc.release || (tc.release == "") != (got == nil) {
				t.Errorf("ReleaseSeq = %q, want %q", got, tc.release)
			}
		})
	}
}

// ReleaseSeq leaves on exactly the line editor's modes that were on.
func TestModesReleaseSeqRandom(t *testing.T) {
	var shell uint8
	for i, f := range flagModes {
		if f.shell {
			shell |= 1 << i
		}
	}
	rng := rand.New(rand.NewPCG(7, 7))
	for range 3000 {
		in := randomModeStream(rng)
		m := modesFrom(in)
		release := string(m.ReleaseSeq())
		if got, want := canonical(*modesFrom(in + release)), (Modes{changed: m.changed & shell}); got != want {
			t.Fatalf("input %q\nReleaseSeq %q\nleft %+v\nwant %+v", in, release, got, want)
		}
	}
}

// checkRoundTrip checks that Prefix rebuilds m on a fresh tracker and that
// ResetSeq then returns it to the defaults. Since the rebuilt state equals m,
// that covers ResetSeq applied to m itself.
func checkRoundTrip(t *testing.T, in string, m *Modes) {
	t.Helper()
	prefix, reset := string(m.Prefix()), string(m.ResetSeq())
	rebuilt := modesFrom(prefix)
	if canonical(*rebuilt) != canonical(*m) {
		t.Fatalf("input %q\nPrefix %q\nrebuilt %+v\nwant    %+v", in, prefix, *rebuilt, *m)
	}
	if got := modesFrom(prefix + reset); canonical(*got) != (Modes{}) {
		t.Fatalf("input %q\nPrefix+ResetSeq %q\nleft %+v", in, prefix+reset, *got)
	}
}

func TestModesRoundTrip(t *testing.T) {
	for _, in := range []string{
		"",
		everything,
		"\x1b[>1u\x1b[?1049h\x1b[>7u\x1b[?1049l",
		"\x1b[?1049h\x1b[>7u\x1b[?1049l",
		"\x1b[?47h\x1b[>2u\x1b[>3u\x1b[?47l\x1b[>1u\x1b[?1047h",
		"\x1b[=5u\x1b[?1049h\x1b[=3;2u",
		strings.Repeat("\x1b[>9u", 20) + "\x1b[?1049h" + strings.Repeat("\x1b[>8u", 17),
		"\x1b[?7l\x1b[?25l",
	} {
		checkRoundTrip(t, in, modesFrom(in))
	}

	// The case where the alternate stack must be rebuilt while the main
	// screen stays selected.
	m := modesFrom(string(modesFrom("\x1b[>1u\x1b[?1049h\x1b[>7u\x1b[?1049l").Prefix()))
	if main, alt := keyStackOf(m, mainScreen), keyStackOf(m, altScreen); !slices.Equal(main, []int{1}) || !slices.Equal(alt, []int{7}) || m.alt != 0 {
		t.Fatalf("rebuilt main %v, alternate %v, alternate screen mode %d; want [1], [7], 0", main, alt, m.alt)
	}
}

// randomModeStream returns output that sets, resets and pushes at random,
// with occasional resets, untracked sequences and text.
func randomModeStream(rng *rand.Rand) string {
	modes := append(slices.Clone(trackedModes), 12, 1015)
	var b strings.Builder
	for range rng.IntN(150) {
		switch k := rng.IntN(100); {
		case k < 40:
			fmt.Fprintf(&b, "\x1b[?%d", modes[rng.IntN(len(modes))])
			for range rng.IntN(3) {
				fmt.Fprintf(&b, ";%d", modes[rng.IntN(len(modes))])
			}
			b.WriteByte("hl"[rng.IntN(2)])
		case k < 65:
			fmt.Fprintf(&b, "\x1b[>%du", rng.IntN(32))
		case k < 77:
			if n := rng.IntN(4); n == 0 {
				b.WriteString("\x1b[<u")
			} else {
				fmt.Fprintf(&b, "\x1b[<%du", n)
			}
		case k < 90:
			fmt.Fprintf(&b, "\x1b[=%d;%du", rng.IntN(32), 1+rng.IntN(3))
		case k < 92:
			b.WriteString("\x1b[!p")
		case k < 93 && rng.IntN(3) == 0:
			b.WriteString("\x1bc")
		default:
			b.WriteString("text\x1b[1;31m\x1b[?u\x1b[>4;2m")
		}
	}
	return b.String()
}

func TestModesRoundTripRandom(t *testing.T) {
	rng := rand.New(rand.NewPCG(5, 5))
	var inactiveAlt, activeAlt, fullStack, mouse int
	for range 3000 {
		in := randomModeStream(rng)
		m := modesFrom(in)
		checkRoundTrip(t, in, m)

		switch {
		case m.alt == 0 && m.keys[altScreen].n > 0:
			inactiveAlt++
		case m.alt != 0 && m.keys[altScreen].n > 0:
			activeAlt++
		}
		if m.keys[mainScreen].n == maxKeyFlags || m.keys[altScreen].n == maxKeyFlags {
			fullStack++
		}
		if m.mouse != 0 && m.mouseEnc != 0 {
			mouse++
		}
	}
	if inactiveAlt == 0 || activeAlt == 0 || fullStack == 0 || mouse == 0 {
		t.Fatalf("weak coverage: %d inactive alternate stacks, %d active, %d full stacks, %d with mouse modes",
			inactiveAlt, activeAlt, fullStack, mouse)
	}
}
