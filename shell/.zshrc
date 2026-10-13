export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad
export PATH="$(brew --prefix coreutils)/libexec/gnubin:$PATH"  

alias cp='cp -iv'
alias mv='mv -iv'
alias ll='ls -FGlAhp'

cheat() {
	curl cht.sh/$1
}

# git() {
# 	if [ $# -gt 0 ] && [ "$1" == "log" ] ; then
# 		shift
# 		command git log --all --graph --oneline "$@"
# 	else
# 		command git "$@"
# 	fi
# }
export PATH="$HOME/.local/bin:$PATH"

# bun completions
[ -s "/Users/jason/.bun/_bun" ] && source "/Users/jason/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

