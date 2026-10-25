# shellcheck shell=sh
# shellcheck disable=SC2154
# Process-identity helpers for the scripts under tools/, sourced after they set
# $dir, the folder their .pid files live in.

# record <name> <pid> notes a process up started, with its start time, which
# stop compares: the pid may since belong to another process.
started() {
	# Unquoted, so ps's padding collapses.
	# shellcheck disable=SC2005,SC2046
	echo $(ps -p "$1" -o lstart= 2>/dev/null)
}
record() {
	echo "$2 $(started "$2")" >"$dir/$1.pid"
}
stop() {
	[ -f "$dir/$1.pid" ] || return 0
	read -r pid started <"$dir/$1.pid"
	rm -f "$dir/$1.pid"
	now=$(started "$pid")
	if [ -z "$now" ]; then
		return 0
	elif [ "$now" = "$started" ]; then
		kill "$pid"
	else
		echo "$1: pid $pid is no longer ours, left alone" >&2
	fi
}
