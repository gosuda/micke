# CI
All compute runs on Depot Ubuntu 24.04. Image builds retain two native hosts,
amd64 and arm64, plus one manifest merge; emulation is not introduced.
Image pushes already run only for image/workflow changes on main and cancel
superseded work. Tag releases already test and cross-build all five assets in
one job. Those publication gates remain because each performs unique work.
