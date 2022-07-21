#!/bin/bash

script_dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
component_root=${script_dir}/../../../

docker build -t clp-core-dependencies-x86-centos7.4:dev ${component_root} --file ${script_dir}/Dockerfile
