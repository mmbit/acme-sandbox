// llama-stdio: llama-server's own chat route over stdin and stdout, in this one process (README.md). It loads the one
// model a manifest names, from the image's model store after checking its digest, says what it actually loaded on one
// JSON line, then answers one Chat Completions request per line until EOF, which frees the model and exits. Every
// other line llama.cpp writes goes to stderr. It runs no tool and opens no socket.
#include "arg.h"
#include "common.h"
#include "llama.h"
#include "llama-ext.h"
#include "hash/hash.h"
#include "server-context.h"
#include "server-common.h"
#include "server-stream.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <string>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

#ifndef RUNTIME_COMMIT
#error "build with -DRUNTIME_COMMIT=<the llama.cpp commit this source is>"
#endif

// (a build for a test names its own folder)
#ifndef MODEL_STORE
#define MODEL_STORE "/opt/inference/models"
#endif

// The JSON lines go to the real stdout alone: everything else on fd 1 (llama.cpp's prints) is sent to stderr
static int out_fd = -1;

static void say(const json & line) {
    std::string text = line.dump_safe() + "\n";
    for (size_t at = 0; at < text.size();) {
        ssize_t n = write(out_fd, text.data() + at, text.size() - at);
        if (n <= 0) {
            exit(1);
        }
        at += (size_t) n;
    }
}

static int refuse(const std::string & why) {
    fprintf(stderr, "llama-stdio: %s\n", why.c_str());
    return 2;
}

// The file's SHA-256 through node's OpenSSL, several times the vendored hash's speed on 25 GB. No shell: argv alone.
static std::string file_sha256(const std::string & path) {
    const char * script = "const h=require('crypto').createHash('sha256');"
                          "require('fs').createReadStream(process.argv[1],{highWaterMark:1<<24})"
                          ".on('data',d=>h.update(d)).on('end',()=>console.log(h.digest('hex')))"
                          ".on('error',()=>process.exit(1))";
    int fds[2];
    if (pipe(fds) != 0) {
        return "";
    }
    pid_t child = fork();
    if (child == 0) {
        dup2(fds[1], STDOUT_FILENO);
        close(fds[0]);
        close(fds[1]);
        execlp("node", "node", "-e", script, path.c_str(), (char *) nullptr);
        _exit(127);
    }
    close(fds[1]);
    char digest[65] = {0};
    ssize_t n = child > 0 ? read(fds[0], digest, 64) : -1;
    close(fds[0]);
    int status = 1;
    if (child > 0) {
        waitpid(child, &status, 0);
    }
    return n == 64 && status == 0 ? std::string(digest, 64) : "";
}

int main(int argc, char ** argv) {
    out_fd = dup(STDOUT_FILENO);
    dup2(STDERR_FILENO, STDOUT_FILENO);

    std::string manifest_path, name;
    for (int i = 1; i + 1 < argc; i += 2) {
        std::string flag = argv[i];
        if (flag == "--manifest") {
            manifest_path = argv[i + 1];
        } else if (flag == "--model") {
            name = argv[i + 1];
        } else {
            return refuse("unknown argument " + flag);
        }
    }
    if (manifest_path.empty() || name.empty() || argc != 5) {
        return refuse("usage: chat --manifest <json> --model <name>");
    }

    json manifest;
    try {
        std::ifstream file(manifest_path);
        manifest = json::parse(std::string(std::istreambuf_iterator<char>(file), {}));
    } catch (const std::exception & error) {
        return refuse(std::string("unreadable manifest: ") + error.what());
    }
    const json & runtime = manifest.at("runtime");
    if (runtime.value("commit", "") != RUNTIME_COMMIT) {
        return refuse(std::string("this runtime is llama.cpp ") + RUNTIME_COMMIT + ", not the manifest's");
    }
    if (runtime.value("parallelRequests", 0) != 1 || runtime.value("transport", "") != "stdio") {
        return refuse("the manifest asks for more than one request at a time over stdio");
    }
    json model;
    for (const auto & one : manifest.at("models")) {
        if (one.value("name", "") == name) {
            model = one;
        }
    }
    if (model.is_null()) {
        return refuse("the manifest has no model " + name);
    }
    const std::string file = model.value("file", "");
    const bool plain = !file.empty() && file[0] != '.' && std::all_of(file.begin(), file.end(), [](char c) {
        return isalnum((unsigned char) c) || c == '.' || c == '_' || c == '-';
    });
    if (!plain) {
        return refuse("the model's file must be a plain name in the model store");
    }
    const std::string path = std::string(MODEL_STORE) + "/" + file;

    // The file as provisioned, never the manifest's word for it
    auto hashing = std::chrono::steady_clock::now();
    const std::string sha256 = file_sha256(path);
    const double hash_seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - hashing).count();
    if (sha256.empty()) {
        return refuse("no model file " + path);
    }
    if (sha256 != model.value("sha256", "")) {
        return refuse("the model file's digest is " + sha256 + ", not the manifest's");
    }

    // The cards: each with a share in gpuSplit, numbered in PCI order as nvidia-smi numbers them (a run's environment
    // holds none of the image's own variables)
    setenv("CUDA_DEVICE_ORDER", "PCI_BUS_ID", 1);
    std::vector<int> devices;
    std::string device_list, split;
    const json & shares = model.at("gpuSplit");
    for (size_t i = 0; i < shares.size(); i++) {
        double share = shares[i].get<double>();
        split += (i ? "," : "") + std::to_string(share);
        if (share > 0) {
            devices.push_back((int) i);
            device_list += (device_list.empty() ? "CUDA" : ",CUDA") + std::to_string(i);
        }
    }
    const int context_tokens = runtime.at("contextTokens").get<int>();

    // llama-server's own options: every layer on the cards named, the whole context asked for (no fitting it down),
    // the model's embedded template through Jinja, reasoning apart in reasoning_content, no prompt cache in RAM
    std::vector<std::string> args = {
        "llama-stdio", "--model", path, "--ctx-size", std::to_string(context_tokens), "--parallel", "1",
        "--fit", "off", "--gpu-layers", "999", "--jinja", "--reasoning-format", "deepseek", "--cache-ram", "0",
        "--no-webui",
    };
    if (devices.empty()) {
        args.insert(args.end(), { "--device", "none" });
    } else {
        args.insert(args.end(), { "--device", device_list, "--split-mode", "layer", "--tensor-split", split });
    }
    std::vector<char *> argv_parsed;
    for (auto & arg : args) {
        argv_parsed.push_back(arg.data());
    }

    common_params params;
    common_init();
    server_stream_session_manager_start();
    if (!common_params_parse((int) argv_parsed.size(), argv_parsed.data(), params, LLAMA_EXAMPLE_SERVER)) {
        return refuse("llama.cpp refused the options");
    }
    llama_backend_init();
    llama_numa_init(params.numa);

    int code = 0;
    {
        server_context ctx_server;
        server_routes routes(params, ctx_server);
        auto loading = std::chrono::steady_clock::now();
        if (!ctx_server.load_model(params)) {
            server_stream_session_manager_stop();
            llama_backend_free();
            return refuse("the model didn't load");
        }
        const double load_seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - loading).count();
        routes.update_meta(ctx_server);

        // What actually loaded: read back from llama.cpp, not from the options above
        llama_context * lctx = ctx_server.get_llama_context();
        const llama_model * lmodel = llama_get_model(lctx);
        char architecture[128] = {0};
        llama_model_meta_val_str(lmodel, "general.architecture", architecture, sizeof(architecture));
        const char * tmpl = llama_model_chat_template(lmodel, nullptr);
        const int total_layers = llama_model_n_layer(lmodel) + llama_model_n_layer_nextn(lmodel) + 1;
        json loaded_devices = json::array();
        std::string backend = "CPU";
        for (int i = 0; i < llama_model_n_devices(lmodel); i++) {
            ggml_backend_dev_t dev = llama_model_get_device(lmodel, i);
            std::string dev_name = ggml_backend_dev_name(dev);
            backend = ggml_backend_reg_name(ggml_backend_dev_backend_reg(dev));
            if (dev_name.rfind("CUDA", 0) == 0) {
                loaded_devices.push_back(std::stoi(dev_name.substr(4)));
            }
        }
        json buffers = json::array();
        for (const auto & [buft, mb] : llama_get_memory_breakdown(lctx)) {
            ggml_backend_dev_t dev = ggml_backend_buft_get_device(buft);
            buffers.push_back({
                { "buffer", ggml_backend_buft_name(buft) },
                { "device", dev ? ggml_backend_dev_name(dev) : "host" },
                { "modelMiB", mb.model / 1048576.0 },
                { "contextMiB", mb.context / 1048576.0 },
                { "computeMiB", mb.compute / 1048576.0 },
            });
        }
        if (!tmpl) {
            ctx_server.terminate();
            code = refuse("the model has no embedded chat template");
        } else {
            std::thread loop([&] { ctx_server.start_loop(); });
            say({
                { "type", "ready" },
                { "modelSha256", sha256 },
                { "runtimeCommit", RUNTIME_COMMIT },
                { "architecture", architecture },
                { "templateSha256", hash_sha256_hex(tmpl, strlen(tmpl)) },
                { "backend", backend },
                { "devices", loaded_devices },
                { "gpuLayers", loaded_devices.empty() ? 0 : std::min(params.n_gpu_layers, total_layers) },
                { "totalLayers", total_layers },
                { "contextTokens", llama_n_ctx(lctx) },
                { "buffers", buffers },
                { "hashSeconds", hash_seconds },
                { "loadSeconds", load_seconds },
            });

            // One request per line, answered before the next is read; the answer carries the request's id
            const std::function<bool()> never = [] { return false; };
            std::string line;
            while (std::getline(std::cin, line)) {
                json id = nullptr;
                try {
                    json body = json::parse(line);
                    id = body.at("id");
                    body.erase("id");
                    body["stream"] = false;
                    server_http_req req{ {}, {}, "/v1/chat/completions", "", body.dump(), {}, never };
                    server_http_res_ptr res = routes.post_chat_completions(req);
                    if (res->is_stream()) {
                        throw std::runtime_error("llama.cpp answered with a stream");
                    }
                    json answer = json::parse(res->data);
                    if (res->status != 200) {
                        say({ { "id", id }, { "error", answer } });
                        continue;
                    }
                    answer["id"] = id;
                    say(answer);
                } catch (const std::exception & error) {
                    say({ { "id", id }, { "error", { { "message", error.what() } } } });
                }
            }

            // EOF: stop the loop, then the context and model go with ctx_server, the CUDA contexts with the process
            ctx_server.terminate();
            loop.join();
        }
    }
    server_stream_session_manager_stop();
    llama_backend_free();
    return code;
}
