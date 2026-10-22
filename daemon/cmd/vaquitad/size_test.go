package main

import (
	"errors"
	"testing"
)

func TestDefaultSize(t *testing.T) {
	for _, c := range []struct{ cols, rows, wantCols, wantRows int }{
		{0, 0, 80, 24},
		{120, 0, 120, 24},
		{0, 40, 80, 40},
		{120, 40, 120, 40},
	} {
		cols, rows, err := defaultSize(c.cols, c.rows, nil)
		if err != nil || cols != c.wantCols || rows != c.wantRows {
			t.Errorf("defaultSize(%d, %d) = %d, %d, %v; want %d, %d", c.cols, c.rows, cols, rows, err, c.wantCols, c.wantRows)
		}
	}
	boom := errors.New("not a terminal")
	if _, _, err := defaultSize(0, 0, boom); err != boom {
		t.Errorf("error not passed through: %v", err)
	}
}
