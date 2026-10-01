/**
 * THE VILLA'S GEOMETRY — generated, and kept that way.
 *
 * Lifted from the 360-villa-os-astra project's `villa-standalone/model.js`,
 * which that repo generates from its React Three Fiber scene. Only the import
 * specifier is changed: it resolved a vendored copy of three there, and
 * resolves the installed package here.
 *
 * It is left as generated JavaScript on purpose. Hand-typing nine hundred
 * lines of emitted geometry would make it something a person maintains, and
 * the next regeneration upstream would have to be hand-merged. The single
 * export is typed in the .d.ts beside this file, which is the whole surface
 * the application touches.
 *
 * Three.js is MIT; see public/villa360-LICENSE.txt.
 */
import * as THREE from 'three';
const useMemo = f => f();
const Fragment = 'fragment';
const h = (type, props, ...children) => ({ type, props: props || {}, children });
function Box({ p, s, c = '#edece6', glass = false, glow = false }) {
    return /*#__PURE__*/ h("mesh", {
        position: p,
        castShadow: !glass,
        receiveShadow: true
    }, /*#__PURE__*/ h("boxGeometry", {
        args: s
    }), /*#__PURE__*/ h("meshStandardMaterial", {
        color: c,
        roughness: glass ? .18 : .78,
        metalness: glass ? .35 : .04,
        transparent: glass,
        opacity: glass ? .43 : 1,
        emissive: glow ? c : '#000000',
        emissiveIntensity: glow ? 1.7 : 0
    }));
}
function Window({ p, w = 1.5, h: h1 = 1.9, rotation = 0, night }) {
    return /*#__PURE__*/ h("group", {
        position: p,
        rotation: [
            0,
            rotation,
            0
        ]
    }, /*#__PURE__*/ h(Box, {
        p: [
            0,
            0,
            0
        ],
        s: [
            w + .16,
            h1 + .16,
            .15
        ],
        c: "#282f30"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            0,
            .09
        ],
        s: [
            w,
            h1,
            .025
        ],
        c: night ? '#d3b17b' : '#566d73'
    }), /*#__PURE__*/ h(Box, {
        p: [
            -w * .31,
            0,
            .105
        ],
        s: [
            w * .28,
            h1,
            .02
        ],
        c: night ? '#edcca0' : '#b6b8ac'
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            0,
            .14
        ],
        s: [
            .04,
            h1,
            .035
        ],
        c: "#292e2e"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            -h1 / 2 - .1,
            .05
        ],
        s: [
            w + .3,
            .12,
            .32
        ]
    }));
}
function Rail({ p, w, rotation = 0 }) {
    return /*#__PURE__*/ h("group", {
        position: p,
        rotation: [
            0,
            rotation,
            0
        ]
    }, /*#__PURE__*/ h(Box, {
        p: [
            0,
            .53,
            0
        ],
        s: [
            w,
            .96,
            .04
        ],
        c: "#a7c8cf",
        glass: true
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            1.04,
            0
        ],
        s: [
            w + .04,
            .045,
            .07
        ],
        c: "#3a4544"
    }), Array.from({
        length: Math.ceil(w / 1.4) + 1
    }, (_, i)=>/*#__PURE__*/ h(Box, {
            key: i,
            p: [
                -w / 2 + i * w / Math.ceil(w / 1.4),
                .52,
                0
            ],
            s: [
                .035,
                1.04,
                .05
            ],
            c: "#4a5351"
        })));
}
function Plant({ p, scale = 1 }) {
    return /*#__PURE__*/ h("group", {
        position: p,
        scale: scale
    }, /*#__PURE__*/ h("mesh", {
        position: [
            0,
            .2,
            0
        ],
        castShadow: true
    }, /*#__PURE__*/ h("cylinderGeometry", {
        args: [
            .25,
            .18,
            .4,
            8
        ]
    }), /*#__PURE__*/ h("meshStandardMaterial", {
        color: "#a7a599"
    })), /*#__PURE__*/ h("mesh", {
        position: [
            0,
            .65,
            0
        ],
        castShadow: true
    }, /*#__PURE__*/ h("cylinderGeometry", {
        args: [
            .035,
            .06,
            .8,
            6
        ]
    }), /*#__PURE__*/ h("meshStandardMaterial", {
        color: "#6d5742"
    })), [
        0,
        1,
        2,
        3,
        4
    ].map((i)=>/*#__PURE__*/ h("mesh", {
            key: i,
            position: [
                Math.sin(i * 2.4) * .22,
                .9 + i % 2 * .21,
                Math.cos(i * 2.4) * .22
            ],
            scale: [
                .32,
                .52,
                .26
            ],
            castShadow: true
        }, /*#__PURE__*/ h("icosahedronGeometry", {
            args: [
                1,
                1
            ]
        }), /*#__PURE__*/ h("meshStandardMaterial", {
            color: [
                '#536951',
                '#6e805b',
                '#425e45'
            ][i % 3],
            roughness: 1
        }))));
}
function Villa({ night }) {
    const stone = useMemo(()=>Array.from({
            length: 35
        }, (_, row)=>Array.from({
                length: 5
            }, (_, col)=>({
                    x: 1.18 + col * .61,
                    y: 3.32 + row * .177,
                    color: [
                        '#b3a694',
                        '#bbae9f',
                        '#c0b3a3',
                        '#a99c8b'
                    ][(row * 7 + col * 3) % 4]
                }))).flat(), []);
    return /*#__PURE__*/ h("group", {
        position: [
            0,
            .08,
            0
        ]
    }, /*#__PURE__*/ h(Box, {
        p: [
            0,
            -.13,
            0
        ],
        s: [
            13.2,
            .3,
            18.2
        ],
        c: "#dad8cf"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            -.015,
            -1
        ],
        s: [
            11.8,
            .06,
            14.8
        ],
        c: "#849079"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            .03,
            0
        ],
        s: [
            9.2,
            .14,
            13.2
        ],
        c: "#cfcbc0"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            1.53,
            -1.1
        ],
        s: [
            8,
            3,
            9.8
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            4.56,
            -1
        ],
        s: [
            8,
            2.85,
            10
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            7.57,
            -1.15
        ],
        s: [
            8,
            2.85,
            9.7
        ]
    }), [
        .15,
        3.12,
        6.12,
        9.1
    ].map((y)=>/*#__PURE__*/ h(Box, {
            key: y,
            p: [
                0,
                y,
                -.3
            ],
            s: [
                8.45,
                .23,
                12.1
            ]
        })), /*#__PURE__*/ h(Box, {
        p: [
            2.4,
            6.02,
            5.19
        ],
        s: [
            3.4,
            5.96,
            1.25
        ],
        c: "#b5a997"
    }), stone.map((b, i)=>/*#__PURE__*/ h(Box, {
            key: i,
            p: [
                b.x,
                b.y,
                5.827
            ],
            s: [
                .6,
                .165,
                .034
            ],
            c: b.color
        })), /*#__PURE__*/ h(Box, {
        p: [
            2.42,
            9.45,
            3.9
        ],
        s: [
            3.4,
            .65,
            .25
        ],
        c: "#b4a795"
    }), /*#__PURE__*/ h(Box, {
        p: [
            -1.7,
            .09,
            6.55
        ],
        s: [
            5.3,
            .09,
            5
        ],
        c: "#b8b4aa"
    }), /*#__PURE__*/ h(Box, {
        p: [
            -3.95,
            1.58,
            5.25
        ],
        s: [
            .34,
            3,
            .45
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            .75,
            1.57,
            5.24
        ],
        s: [
            .38,
            3,
            .52
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            -1.6,
            1.54,
            3.82
        ],
        s: [
            4.1,
            2.85,
            .12
        ],
        c: "#8f674a"
    }), Array.from({
        length: 14
    }, (_, i)=>/*#__PURE__*/ h(Box, {
            key: i,
            p: [
                -3.55 + i * .29,
                1.54,
                3.9
            ],
            s: [
                .016,
                2.85,
                .025
            ],
            c: "#74513c"
        })), /*#__PURE__*/ h(Box, {
        p: [
            2.7,
            1.52,
            5.13
        ],
        s: [
            2.25,
            2.8,
            .3
        ],
        c: "#ddd4c5"
    }), /*#__PURE__*/ h(Window, {
        p: [
            2.7,
            1.63,
            5.31
        ],
        w: 1.1,
        h: 2.5,
        night: night
    }), [
        0,
        1,
        2
    ].map((i)=>/*#__PURE__*/ h(Box, {
            key: i,
            p: [
                2.65,
                .1 + i * .08,
                6 - i * .25
            ],
            s: [
                2.45,
                .14,
                1.1 - i * .22
            ],
            c: "#cecdc5"
        })), [
        3.25,
        6.25
    ].map((y)=>/*#__PURE__*/ h("group", {
            key: y
        }, /*#__PURE__*/ h(Box, {
            p: [
                -1.65,
                y + 2.7,
                4.76
            ],
            s: [
                5.1,
                .11,
                2.25
            ],
            c: "#98704c"
        }), /*#__PURE__*/ h(Window, {
            p: [
                -1.55,
                y + 1.25,
                4.04
            ],
            w: 3.8,
            h: 2.3,
            night: night
        }), /*#__PURE__*/ h(Rail, {
            p: [
                -1.65,
                y,
                5.6
            ],
            w: 4.6
        }), /*#__PURE__*/ h(Rail, {
            p: [
                -3.97,
                y,
                4.88
            ],
            w: 1.45,
            rotation: Math.PI / 2
        }), /*#__PURE__*/ h(Plant, {
            p: [
                -3.2,
                y,
                5
            ],
            scale: .85
        }), /*#__PURE__*/ h(Plant, {
            p: [
                -.2,
                y,
                4.9
            ],
            scale: .7
        }), [
            -3,
            -1.3,
            .3
        ].map((x)=>/*#__PURE__*/ h(Box, {
                key: x,
                p: [
                    x,
                    y + 2.63,
                    5.15
                ],
                s: [
                    .11,
                    .025,
                    .11
                ],
                c: "#ffe3ab",
                glow: night
            })))), /*#__PURE__*/ h(Box, {
        p: [
            -1.5,
            3.56,
            5.64
        ],
        s: [
            2.1,
            .55,
            .09
        ],
        c: "#a87746"
    }), Array.from({
        length: 21
    }, (_, i)=>/*#__PURE__*/ h(Box, {
            key: i,
            p: [
                -3.9 + i * .062,
                3.65,
                5.65
            ],
            s: [
                .024,
                .85,
                .05
            ],
            c: "#545a55"
        })), /*#__PURE__*/ h(Box, {
        p: [
            -4.08,
            5.07,
            5.43
        ],
        s: [
            .22,
            4,
            .24
        ]
    }), [
        -1,
        1
    ].map((side)=>/*#__PURE__*/ h("group", {
            key: side
        }, [
            1.6,
            4.7,
            7.7
        ].map((y, floor)=>[
                -4.5,
                -.9,
                2.1
            ].map((z, i)=>/*#__PURE__*/ h(Window, {
                    key: `${y}-${z}`,
                    p: [
                        side * 4.03,
                        y,
                        z
                    ],
                    w: i === 1 ? .9 : 1.5,
                    h: i === 1 ? .65 : 1.85,
                    rotation: side * Math.PI / 2,
                    night: night
                }))), /*#__PURE__*/ h(Box, {
            p: [
                side * 5.1,
                .48,
                -1.4
            ],
            s: [
                .13,
                .9,
                13.2
            ],
            c: "#d4d5cd"
        }), [
            -6,
            -3.5,
            -1,
            1.5,
            3.5
        ].map((z)=>/*#__PURE__*/ h(Plant, {
                key: z,
                p: [
                    side * 4.63,
                    .12,
                    z
                ],
                scale: .8
            })))), [
        1.55,
        4.6,
        7.6
    ].map((y)=>[
            -2.35,
            .2,
            2.65
        ].map((x)=>/*#__PURE__*/ h(Window, {
                key: `${x}-${y}`,
                p: [
                    x,
                    y,
                    -6.03
                ],
                w: 1.7,
                h: 1.8,
                rotation: Math.PI,
                night: night
            }))), /*#__PURE__*/ h(Box, {
        p: [
            0,
            9.24,
            -.5
        ],
        s: [
            8,
            .07,
            10.5
        ],
        c: "#c0bcae"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            9.55,
            -6.15
        ],
        s: [
            8.45,
            .9,
            .18
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            -4.12,
            9.55,
            -.8
        ],
        s: [
            .18,
            .9,
            10.6
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            4.12,
            9.55,
            -1.35
        ],
        s: [
            .18,
            .9,
            9.4
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            2.6,
            9.9,
            -4.35
        ],
        s: [
            2.65,
            1.5,
            3.2
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            2.6,
            10.72,
            -4.35
        ],
        s: [
            2.85,
            .16,
            3.4
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            -1.65,
            9.24,
            4.65
        ],
        s: [
            5.3,
            .24,
            2.5
        ]
    }), [
        -3,
        -.7,
        1
    ].map((x)=>/*#__PURE__*/ h(Plant, {
            key: x,
            p: [
                x,
                9.3,
                -5.45
            ],
            scale: .75
        })), /*#__PURE__*/ h("group", {
        position: [
            -1.7,
            .15,
            5.25
        ]
    }, /*#__PURE__*/ h(Box, {
        p: [
            0,
            .52,
            0
        ],
        s: [
            1.75,
            .58,
            3.8
        ],
        c: "#343c40"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            .95,
            -.25
        ],
        s: [
            1.5,
            .6,
            1.9
        ],
        c: "#49575d"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            .97,
            .73
        ],
        s: [
            1.4,
            .42,
            .025
        ],
        c: "#89a3ab"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            .41,
            1.92
        ],
        s: [
            1.55,
            .1,
            .07
        ],
        c: "#899397"
    }), [
        -.62,
        .62
    ].map((x)=>/*#__PURE__*/ h(Box, {
            key: x,
            p: [
                x,
                .66,
                1.92
            ],
            s: [
                .37,
                .12,
                .04
            ],
            c: "#e3e4ce"
        })), [
        -.86,
        .86
    ].map((x)=>[
            -1.23,
            1.18
        ].map((z)=>/*#__PURE__*/ h("mesh", {
                key: `${x}-${z}`,
                position: [
                    x,
                    .34,
                    z
                ],
                rotation: [
                    0,
                    0,
                    Math.PI / 2
                ],
                castShadow: true
            }, /*#__PURE__*/ h("cylinderGeometry", {
                args: [
                    .34,
                    .34,
                    .18,
                    20
                ]
            }), /*#__PURE__*/ h("meshStandardMaterial", {
                color: "#27292a",
                roughness: .95
            }))))), /*#__PURE__*/ h(Box, {
        p: [
            4,
            .46,
            7.1
        ],
        s: [
            2.9,
            .8,
            .18
        ],
        c: "#deded6"
    }), /*#__PURE__*/ h(Box, {
        p: [
            -4.8,
            .46,
            7.1
        ],
        s: [
            1.25,
            .8,
            .18
        ],
        c: "#deded6"
    }), /*#__PURE__*/ h(Plant, {
        p: [
            4.55,
            .1,
            6.7
        ]
    }), /*#__PURE__*/ h(Plant, {
        p: [
            -4.8,
            .1,
            6.65
        ]
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            -.18,
            10.7
        ],
        s: [
            50,
            .12,
            5
        ],
        c: "#92979a"
    }), /*#__PURE__*/ h(Box, {
        p: [
            0,
            -.1,
            8.1
        ],
        s: [
            30,
            .13,
            .25
        ],
        c: "#cacbc7"
    }), [
        -10,
        10
    ].map((x)=>/*#__PURE__*/ h(Plant, {
            key: x,
            p: [
                x,
                -.1,
                -4
            ],
            scale: 3.2
        })));
}

const geometry = { boxGeometry: THREE.BoxGeometry, cylinderGeometry: THREE.CylinderGeometry, icosahedronGeometry: THREE.IcosahedronGeometry };
function render(node, parent) {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) { node.forEach(n => render(n, parent)); return; }
  if (typeof node.type === 'function') { render(node.type(node.props), parent); return; }
  const p = node.props;
  if (node.type === 'fragment') { node.children.forEach(n => render(n, parent)); return; }
  if (geometry[node.type]) { parent.geometry = new geometry[node.type](...p.args); return; }
  if (node.type === 'meshStandardMaterial') { parent.material = new THREE.MeshStandardMaterial(p); return; }
  const obj = node.type === 'mesh' ? new THREE.Mesh() : new THREE.Group();
  if (p.position) obj.position.fromArray(p.position);
  if (p.rotation) obj.rotation.set(...p.rotation);
  if (p.scale) Array.isArray(p.scale) ? obj.scale.fromArray(p.scale) : obj.scale.setScalar(p.scale);
  obj.castShadow = !!p.castShadow; obj.receiveShadow = !!p.receiveShadow;
  node.children.forEach(n => render(n, obj)); parent.add(obj);
}
export function createVilla(night) { const group = new THREE.Group(); render(h(Villa, { night }), group); return group; }
