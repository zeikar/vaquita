package main

import "testing"

func TestCell(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"/tmp/a b", "/tmp/a b"},
		{"/tmp/한글", "/tmp/한글"},
		{"'printf' '%s\n'", `"'printf' '%s\n'"`},
		{"a\tb", `"a\tb"`},
		{"\x1b[31mred", `"\x1b[31mred"`},
		{"bad\xffutf8", `"bad\xffutf8"`},
	} {
		if got := cell(tc.in); got != tc.want {
			t.Errorf("cell(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}
