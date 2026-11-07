cmake_minimum_required(VERSION 3.26)
project(dial8_local_stt LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The upstream SDK, built and installed by build.sh into .out/sdk (or, later,
# unpacked from an upstream release archive). We link ONLY its public C ABI
# (nemo_speech/asr.h) so upstream internals can change freely underneath.
find_package(NeMoSpeech REQUIRED COMPONENTS ASR)

set(NEMO_UPSTREAM_SHA "unknown" CACHE STRING "Pinned upstream commit, reported in hello")

add_executable(dial8-local-stt src/main.cpp)
target_link_libraries(dial8-local-stt PRIVATE NeMoSpeech::ASR)
# nlohmann/json ships with upstream's llama.cpp submodule (MIT).
target_include_directories(dial8-local-stt PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/upstream/llama.cpp/vendor)
target_compile_definitions(dial8-local-stt PRIVATE NEMO_UPSTREAM_SHA="${NEMO_UPSTREAM_SHA}")
target_compile_options(dial8-local-stt PRIVATE -Wall -Wextra)

# Dylibs live in Dial8.app/Contents/Frameworks (bundle) or .out/lib (dev).
set_target_properties(dial8-local-stt PROPERTIES
    BUILD_WITH_INSTALL_RPATH ON
    INSTALL_RPATH "@executable_path/../Frameworks;@executable_path/../lib")
