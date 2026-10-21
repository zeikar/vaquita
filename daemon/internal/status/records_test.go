package status

import (
	"fmt"
	"testing"
)

func ids(rs *Records) []string {
	var out []string
	for _, r := range rs.Snapshot() {
		out = append(out, r.ID)
	}
	return out
}

func checkIDs(t *testing.T, rs *Records, want ...string) {
	t.Helper()
	got := ids(rs)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("records %q, want %q", got, want)
	}
}

func TestRecordsUpsertKeepsLastReport(t *testing.T) {
	var rs Records
	rs.Apply(Report{State: "working", Msg: "a"})
	rs.Apply(Report{ID: "x", State: "idle"})
	rs.Apply(Report{State: "done", Msg: "b"})
	snap := rs.Snapshot()
	if len(snap) != 2 || snap[0].ID != "x" || snap[1].State != "done" || snap[1].Msg != "b" {
		t.Fatalf("snapshot %+v", snap)
	}
	snap[0].State = "mutated"
	if rs.Snapshot()[0].State != "idle" {
		t.Fatal("Snapshot aliases the records")
	}
}

func TestRecordsClearWithoutIDWipesAll(t *testing.T) {
	var rs Records
	rs.Apply(Report{State: "working"})
	rs.Apply(Report{ID: "a", State: "working"})
	rs.Apply(Report{State: "clear"})
	checkIDs(t, &rs)
}

func TestRecordsClearWithIDDeletesSubtree(t *testing.T) {
	var rs Records
	for _, id := range []string{"", "a", "a/b", "a/b/c", "ab", "b"} {
		rs.Apply(Report{ID: id, State: "working"})
	}
	rs.Apply(Report{ID: "a", State: "clear"})
	checkIDs(t, &rs, "", "ab", "b")
	// Clearing an unknown id is harmless.
	rs.Apply(Report{ID: "zzz", State: "clear"})
	checkIDs(t, &rs, "", "ab", "b")
}

func TestRecordsEvictsStalest(t *testing.T) {
	var rs Records
	for i := 0; i < MaxRecords; i++ {
		rs.Apply(Report{ID: fmt.Sprint(i), State: "working"})
	}
	// Updating the oldest makes record 1 the stalest.
	rs.Apply(Report{ID: "0", State: "idle"})
	rs.Apply(Report{ID: "new", State: "working"})
	got := ids(&rs)
	if len(got) != MaxRecords {
		t.Fatalf("%d records, want %d", len(got), MaxRecords)
	}
	for _, id := range got {
		if id == "1" {
			t.Fatal("stalest record 1 was not evicted")
		}
	}
	if got[0] != "2" || got[len(got)-1] != "new" {
		t.Fatalf("order %q ... %q", got[0], got[len(got)-1])
	}
}

func TestRecordsReset(t *testing.T) {
	var rs Records
	rs.Reset() // on the zero value
	rs.Apply(Report{State: "done"})
	rs.Reset()
	checkIDs(t, &rs)
	rs.Apply(Report{State: "done"})
	checkIDs(t, &rs, "")
}

func TestRecordsPromptStartKeepsOutcomes(t *testing.T) {
	var rs Records
	for i, s := range []string{"idle", "working", "done", "blocked", "error"} {
		rs.Apply(Report{ID: fmt.Sprint(i), State: s})
	}
	rs.PromptStart()
	checkIDs(t, &rs, "2", "4")
}
