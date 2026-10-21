package status

import (
	"slices"
	"strings"
)

// Record is the last report stored for an id, with the order it arrived in.
type Record struct {
	Report
	// Seq increases with every stored report, across all records; the
	// stalest record has the lowest.
	Seq uint64
}

// Records holds the live status records of one session, keyed by id (the root
// record's id is ""). It is not safe for concurrent use.
type Records struct {
	byID map[string]Record
	seq  uint64
}

// Apply stores r. A clear report stores nothing: without an id it wipes all
// records, with one it deletes that record and every record below it. Other
// reports replace the record of their id. At MaxRecords a new id evicts the
// record updated longest ago, which may be the root one.
func (rs *Records) Apply(r Report) {
	if r.State == StateClear {
		if r.ID == "" {
			clear(rs.byID)
			return
		}
		delete(rs.byID, r.ID)
		prefix := r.ID + "/"
		for id := range rs.byID {
			if strings.HasPrefix(id, prefix) {
				delete(rs.byID, id)
			}
		}
		return
	}
	if rs.byID == nil {
		rs.byID = make(map[string]Record)
	}
	if _, ok := rs.byID[r.ID]; !ok && len(rs.byID) >= MaxRecords {
		var stalest string
		var min uint64
		first := true
		for id, rec := range rs.byID {
			if first || rec.Seq < min {
				stalest, min, first = id, rec.Seq, false
			}
		}
		delete(rs.byID, stalest)
	}
	rs.seq++
	rs.byID[r.ID] = Record{Report: r, Seq: rs.seq}
}

// Reset drops every record, as a terminal reset (RIS) does.
func (rs *Records) Reset() { clear(rs.byID) }

// PromptStart drops everything but done and error records: a new shell
// prompt means whatever was working or blocked is over, while an outcome the
// user has not looked at yet stays.
func (rs *Records) PromptStart() {
	for id, rec := range rs.byID {
		if rec.State != StateDone && rec.State != StateError {
			delete(rs.byID, id)
		}
	}
}

// Snapshot returns a copy of the records, oldest update first.
func (rs *Records) Snapshot() []Record {
	out := make([]Record, 0, len(rs.byID))
	for _, rec := range rs.byID {
		out = append(out, rec)
	}
	slices.SortFunc(out, func(a, b Record) int {
		switch {
		case a.Seq < b.Seq:
			return -1
		case a.Seq > b.Seq:
			return 1
		}
		return 0
	})
	return out
}
